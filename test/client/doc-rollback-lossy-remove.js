var Backend = require('../../lib/backend');
var ShareDB = require('../../lib/client');
var json1 = require('ot-json1');
var expect = require('chai').expect;

// A rejected op is normally rolled back by applying type.invert(op) locally.
// For json1 that is only correct when every remove in the op carries its
// captured content. A "value-less" remove (`{r: true}`) — what a transform
// under a permissive conflict policy produces when two clients concurrently
// replace the same path — inverts to `{i: true}`: the rollback INSERTS the
// literal boolean `true` where the old value was. On `meta.updated_at` that
// corrupts the doc's version and cascades (observed in production 2026-09-03).
// Such ops must roll back by re-fetching the server snapshot instead.
describe('Doc._rollback with a lossy (value-less) json1 remove', function() {
  var backend;
  var OLD = '20260901000000000';
  var NEW = '20260901000000001';
  var PATH = ['meta', 'updated_at', 'utc_time'];

  before(function() {
    ShareDB.types.register(json1.type);
  });

  beforeEach(function(done) {
    backend = new Backend();
    var seeder = backend.connect();
    seeder.get('docs', 'd1').create({meta: {updated_at: {utc_time: OLD}}}, json1.type.name, done);
  });

  afterEach(function(done) {
    backend.close(done);
  });

  // Reject the next submitted op only (the create in beforeEach must succeed).
  function rejectNextSubmit() {
    var armed = true;
    backend.use('submit', function(request, next) {
      if (armed && request.op && request.op.op) {
        armed = false;
        return next({message: 'rejected', code: 'ERR_OP_SUBMIT_REJECTED'});
      }
      next();
    });
  }

  it('does NOT insert the literal `true` on rollback; it re-fetches the server snapshot', function(done) {
    rejectNextSubmit();
    var doc = backend.connect().get('docs', 'd1');
    doc.fetch(function(err) {
      if (err) return done(err);
      var hardRollbacks = 0;
      var original = doc._hardRollback;
      doc._hardRollback = function() { hardRollbacks++; return original.apply(this, arguments); };

      // Simulate a transform-stripped replace: {r:true, i:NEW}
      doc.submitOp(json1.replaceOp(PATH, true, NEW), function() {
        // After the rejection settles, the value must be the SERVER's, never `true`.
        setTimeout(function() {
          expect(doc.data.meta.updated_at.utc_time).to.equal(OLD);
          expect(doc.data.meta.updated_at.utc_time).to.not.equal(true);
          expect(hardRollbacks).to.equal(1);          // took the re-fetch path
          done();
        }, 30);
      });
      // Optimistically applied before the server answers.
      expect(doc.data.meta.updated_at.utc_time).to.equal(NEW);
    });
  });

  it('control: a remove WITH captured content still rolls back by cheap local invert', function(done) {
    rejectNextSubmit();
    var doc = backend.connect().get('docs', 'd1');
    doc.fetch(function(err) {
      if (err) return done(err);
      var hardRollbacks = 0;
      var original = doc._hardRollback;
      doc._hardRollback = function() { hardRollbacks++; return original.apply(this, arguments); };

      doc.submitOp(json1.replaceOp(PATH, OLD, NEW), function() {
        setTimeout(function() {
          expect(doc.data.meta.updated_at.utc_time).to.equal(OLD);   // faithfully inverted
          expect(hardRollbacks).to.equal(0);                           // no re-fetch needed
          done();
        }, 30);
      });
    });
  });

  it('pre-fix behaviour, for the record: json1 invert of a value-less remove inserts `true`', function() {
    var inverse = json1.type.invert(json1.replaceOp(PATH, true, NEW));
    expect(JSON.stringify(inverse)).to.contain('"i":true');
  });
});
