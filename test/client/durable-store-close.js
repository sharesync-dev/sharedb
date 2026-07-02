var expect = require('chai').expect;
var DurableStore = require('../../lib/client/durable-store');
var InMemoryStorage = require('../../lib/client/storage/in-memory-storage');

describe('DurableStore close()', function() {
  var durableStore;
  var storage;

  function makeMockDoc(id) {
    return {
      collection: 'testCollection',
      id: id,
      data: {title: 'Test Doc ' + id},
      version: 1,
      type: {name: 'json0'},
      pendingOps: [],
      inflightOp: null,
      preventCompose: false,
      submitSource: false,
      connection: {id: 'test-connection'}
    };
  }

  beforeEach(function(done) {
    storage = new InMemoryStorage({debug: false});
    durableStore = new DurableStore(storage, {debug: false});
    storage.initialize(function() {
      durableStore.initialize(function() {
        done();
      });
    });
  });

  it('drops writes issued after close, invoking their callbacks with null', function(done) {
    durableStore.close();
    durableStore.putDoc(makeMockDoc('doc-after-close'), function(err) {
      expect(err).to.be.null;
      expect(durableStore.getWriteQueueSize()).to.equal(0);
      durableStore.getDoc('testCollection', 'doc-after-close', function(err, docData) {
        expect(docData).to.not.exist;
        done();
      });
    });
  });

  it('does not write queued docs once closed', function(done) {
    // Suspend the write loop so the doc stays queued, then close.
    durableStore.setAutoBatchEnabled(false);
    durableStore.putDoc(makeMockDoc('doc-queued'), function() {});
    expect(durableStore.getWriteQueueSize()).to.equal(1);

    durableStore.close();
    expect(durableStore.getWriteQueueSize()).to.equal(0);

    // Re-enabling auto-batch must not resurrect the write.
    durableStore.setAutoBatchEnabled(true);
    durableStore.getDoc('testCollection', 'doc-queued', function(err, docData) {
      expect(docData).to.not.exist;
      done();
    });
  });

  it('resolves pending flush callbacks on close', function(done) {
    durableStore.setAutoBatchEnabled(false);
    durableStore.putDoc(makeMockDoc('doc-flush'), function() {});
    // Simulate an in-flight batch so flush() parks its callback instead of writing.
    durableStore.busy = true;
    var flushed = false;
    durableStore.flush(function(err) {
      expect(err).to.be.null;
      flushed = true;
    });
    expect(flushed).to.equal(false);
    durableStore.close();
    expect(flushed).to.equal(true);
    durableStore.busy = false;
    done();
  });

  it('flush after close resolves immediately', function(done) {
    durableStore.close();
    durableStore.flush(function(err) {
      expect(err).to.be.null;
      done();
    });
  });

  it('is idempotent', function() {
    durableStore.close();
    durableStore.close();
    expect(durableStore.closed).to.equal(true);
  });

  it('still writes normally before close', function(done) {
    durableStore.putDoc(makeMockDoc('doc-before-close'), function(err) {
      expect(err).to.be.null;
      durableStore.getDoc('testCollection', 'doc-before-close', function(err, docData) {
        expect(docData).to.exist;
        durableStore.close();
        done();
      });
    });
  });
});
