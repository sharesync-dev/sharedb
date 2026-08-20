var Backend = require('../../lib/backend');
var DurableStore = require('../../lib/client/durable-store');
var InMemoryStorage = require('../../lib/client/storage/in-memory-storage');
var expect = require('chai').expect;

// Observability for write loss. Remote-op persistence (Doc._handleOp →
// _putToDurableStore) passes NO callback to putDoc, so a rejected, failed, or
// dropped write is invisible to the application unless the store announces it.
// These events are that announcement.
describe('DurableStore write-loss events', function() {
  var backend;
  var connection;
  var store;

  beforeEach(function(done) {
    backend = new Backend();
    var storage = new InMemoryStorage({ debug: false });
    connection = backend.connect();
    store = connection.durableStore = new DurableStore(storage, { debug: false });
    store.on('ready', done);
    store.initialize();
  });

  afterEach(function(done) {
    connection.close();
    backend.close(done);
  });

  function whenPersisted(callback) {
    if (!store.hasDocsInWriteQueue()) {
      return setTimeout(function() {
        if (!store.hasDocsInWriteQueue()) return callback();
        store.once('no persist pending', callback);
      }, 20);
    }
    store.once('no persist pending', callback);
  }

  function createTwo(callback) {
    var a = connection.get('items', 'a');
    var b = connection.get('items', 'b');
    a.create({n: 1}, function(err) {
      if (err) return callback(err);
      b.create({n: 1}, function(err2) {
        if (err2) return callback(err2);
        whenPersisted(function() { callback(null, a, b); });
      });
    });
  }

  it('emits "write rejected" with the offender AND every sibling in the discarded batch', function(done) {
    createTwo(function(err, a, b) {
      if (err) return done(err);
      // Forge a future inventory version for `a` so its next write regresses.
      store.inventory.payload.collections.items.a.v = 99;
      var bBefore = store.inventory.payload.collections.items.b.v;

      store.once('write rejected', function(event) {
        expect(event.reason).to.equal('regression');
        expect(event.error).to.be.an('error');
        expect(event.offender).to.include({collection: 'items', id: 'a', oldVersion: 99, check: 'regression'});
        var ids = event.docs.map(function(d) { return d.collection + '/' + d.id; });
        expect(ids).to.have.members(['items/a', 'items/b']);   // b is collateral
        setTimeout(function() {
          // The whole batch was discarded: b's inventory entry never advanced.
          expect(store.inventory.payload.collections.items.b.v).to.equal(bBefore);
          done();
        }, 10);
      });

      // Queue both into ONE batch: hold the writer, enqueue, release.
      store.busy = true;
      store.putDoc(a);
      store.putDoc(b);
      store.busy = false;
      store._putNextBatchFromQueue();
    });
  });

  it('emits "write rejected" with check=type on a version type mismatch', function(done) {
    createTwo(function(err, a) {
      if (err) return done(err);
      store.inventory.payload.collections.items.a.v = 'not-a-number';
      store.once('write rejected', function(event) {
        expect(event.reason).to.equal('type');
        expect(event.offender.check).to.equal('type');
        expect(event.offender.id).to.equal('a');
        done();
      });
      store.putDoc(a);
    });
  });

  it('emits "write failed" when the storage adapter errors', function(done) {
    createTwo(function(err, a) {
      if (err) return done(err);
      var original = store.storage.writeRecords;
      store.storage.writeRecords = function(records, cb) {
        store.storage.writeRecords = original;
        cb(new Error('disk full'));
      };
      store.once('write failed', function(event) {
        expect(event.reason).to.equal('storage');
        expect(event.error.message).to.equal('disk full');
        expect(event.docs.map(function(d) { return d.id; })).to.deep.equal(['a']);
        done();
      });
      store.putDoc(a);
    });
  });

  it('emits "write dropped" for a write after close', function(done) {
    createTwo(function(err, a) {
      if (err) return done(err);
      store.once('write dropped', function(event) {
        expect(event.reason).to.equal('closed');
        expect(event.doc).to.include({collection: 'items', id: 'a'});
        done();
      });
      store.close();
      store.putDoc(a);
    });
  });

  it('emits "write dropped" (closed-with-queue) for writes still queued when close() runs', function(done) {
    createTwo(function(err, a, b) {
      if (err) return done(err);
      store.once('write dropped', function(event) {
        expect(event.reason).to.equal('closed-with-queue');
        expect(event.docs.map(function(d) { return d.id; })).to.have.members(['a', 'b']);
        done();
      });
      store.busy = true;          // hold the writer so both stay queued
      store.putDoc(a);
      store.putDoc(b);
      store.close();
    });
  });
});
