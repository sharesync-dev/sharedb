var expect = require('chai').expect;
var DurableStore = require('../../lib/client/durable-store');
var InMemoryStorage = require('../../lib/client/storage/in-memory-storage');

// restoreDocFromDurableRecord is only entered when the inventory says the doc
// is present, so an empty record read means the store is inconsistent. It must
// never call back with bare success (which leaves the doc un-hydrated and
// reading as "does not exist" upstream): it refetches from the server when the
// connection allows, and otherwise surfaces ERR_DOC_MISSING_FROM_DURABLE_STORE.
describe('DurableStore restoreDocFromDurableRecord with a missing record', function() {
  var durableStore;
  var storage;

  function makeMockDoc(id, opts) {
    opts = opts || {};
    return {
      collection: 'testCollection',
      id: id,
      data: undefined,
      version: null,
      type: null,
      pendingOps: [],
      inflightOp: null,
      preventCompose: false,
      submitSource: false,
      connection: {id: 'test-connection', canSend: !!opts.canSend},
      fetchCalls: 0,
      fetch: function(callback) {
        this.fetchCalls++;
        callback && callback();
      },
      _setData: function(data) { this.data = data; },
      _setType: function(typeName) { this.type = typeName ? {name: typeName} : null; },
      emit: function() {}
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

  it('refetches from the server when the connection can send', function(done) {
    var doc = makeMockDoc('missing-doc', {canSend: true});
    durableStore.restoreDocFromDurableRecord(doc, function(error) {
      expect(error).to.not.exist;
      expect(doc.fetchCalls).to.equal(1);
      done();
    });
  });

  it('fails with ERR_DOC_MISSING_FROM_DURABLE_STORE when the connection cannot send', function(done) {
    var doc = makeMockDoc('missing-doc', {canSend: false});
    durableStore.restoreDocFromDurableRecord(doc, function(error) {
      expect(error).to.exist;
      expect(error.code).to.equal('ERR_DOC_MISSING_FROM_DURABLE_STORE');
      expect(doc.fetchCalls).to.equal(0);
      done();
    });
  });

  it('still hydrates normally when the record exists', function(done) {
    var record = {
      collection: 'testCollection',
      id: 'present-doc',
      data: {title: 'Present'},
      version: 3,
      type: {name: 'json0'},
      pendingOps: [],
      inflightOp: null,
      preventCompose: false,
      submitSource: false,
      connection: {id: 'test-connection'}
    };
    durableStore.putDoc(record, function() {
      var doc = makeMockDoc('present-doc', {canSend: false});
      durableStore.restoreDocFromDurableRecord(doc, function(error) {
        expect(error).to.not.exist;
        expect(doc.data).to.eql({title: 'Present'});
        expect(doc.version).to.equal(3);
        expect(doc.fetchCalls).to.equal(0);
        done();
      });
    });
  });
});
