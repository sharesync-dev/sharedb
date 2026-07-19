var expect = require('chai').expect;
var DurableStore = require('../../lib/client/durable-store');
var InMemoryStorage = require('../../lib/client/storage/in-memory-storage');

// A server-side doc deletion must be persistable over a stale local record.
// Deleted docs have data: undefined, so with an extVersionDecoder configured
// makeInventoryVersion yields null — which can never pass the inventory's
// version type/regression checks against a real prior version. Without the
// deletion carve-out, the type-null write is rejected (silently, when enqueued
// without a callback) and the stale record remains restorable forever.
describe('DurableStore deleted-doc persistence', function() {
  var durableStore;
  var storage;

  function makeDocLike(id, opts) {
    opts = opts || {};
    return {
      collection: 'testCollection',
      id: id,
      data: opts.data,
      version: opts.version || null,
      type: opts.typeName ? {name: opts.typeName} : null,
      pendingOps: [],
      inflightOp: null,
      preventCompose: false,
      submitSource: false,
      connection: {id: 'test-connection'},
      _setData: function(data) { this.data = data; },
      _setType: function(typeName) { this.type = typeName ? {name: typeName} : null; },
      emit: function() {}
    };
  }

  beforeEach(function(done) {
    storage = new InMemoryStorage({debug: false});
    durableStore = new DurableStore(storage, {
      debug: false,
      // Mirrors the app's decoder: version comes out of the doc data.
      extVersionDecoder: function(docData) {
        return (docData && docData.meta && docData.meta.updated_at) ?
          docData.meta.updated_at.utc_time : null;
      }
    });
    storage.initialize(function() {
      durableStore.initialize(function() {
        done();
      });
    });
  });

  function putLiveDoc(id, callback) {
    var live = makeDocLike(id, {
      data: {meta: {updated_at: {utc_time: '20260719120000000'}}, payload: {text: 'hello'}},
      version: 3,
      typeName: 'json0'
    });
    durableStore.putDoc(live, callback);
  }

  it('accepts a type-null record over a live record with a decoded version', function(done) {
    putLiveDoc('doomed-doc', function(putError) {
      expect(putError).to.not.exist;
      var deleted = makeDocLike('doomed-doc', {version: 4});
      durableStore.putDoc(deleted, function(delError) {
        expect(delError).to.not.exist;
        durableStore.getDoc('testCollection', 'doomed-doc', function(getError, record) {
          expect(getError).to.not.exist;
          expect(record.type_name).to.equal(null);
          expect(record.data).to.not.exist;
          done();
        });
      });
    });
  });

  it('keeps the doc in inventory with a null version after deletion', function(done) {
    putLiveDoc('doomed-doc', function() {
      var deleted = makeDocLike('doomed-doc', {version: 4});
      durableStore.putDoc(deleted, function() {
        expect(durableStore.isDocInInventory('testCollection', 'doomed-doc')).to.equal(true);
        // Any versioned read must miss (null is older than everything),
        // forcing a server fetch that re-observes the deletion.
        expect(durableStore.isDocInInventory('testCollection', 'doomed-doc', '20260719120000000')).to.equal(false);
        done();
      });
    });
  });

  it('restores the doc as deleted (type null, no data) after the deletion write', function(done) {
    putLiveDoc('doomed-doc', function() {
      var deleted = makeDocLike('doomed-doc', {version: 4});
      durableStore.putDoc(deleted, function() {
        var restored = makeDocLike('doomed-doc');
        restored.connection.canSend = false;
        durableStore.restoreDocFromDurableRecord(restored, function(error) {
          expect(error).to.not.exist;
          expect(restored.type).to.equal(null);
          expect(restored.data).to.not.exist;
          done();
        });
      });
    });
  });

  it('allows a re-create write after a deletion (null inventory version)', function(done) {
    putLiveDoc('phoenix-doc', function() {
      var deleted = makeDocLike('phoenix-doc', {version: 4});
      durableStore.putDoc(deleted, function() {
        var recreated = makeDocLike('phoenix-doc', {
          data: {meta: {updated_at: {utc_time: '20260719130000000'}}, payload: {text: 'again'}},
          version: 5,
          typeName: 'json0'
        });
        durableStore.putDoc(recreated, function(error) {
          expect(error).to.not.exist;
          durableStore.getDoc('testCollection', 'phoenix-doc', function(getError, record) {
            expect(getError).to.not.exist;
            expect(record.type_name).to.equal('json0');
            expect(record.data.payload.text).to.equal('again');
            done();
          });
        });
      });
    });
  });
});
