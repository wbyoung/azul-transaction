'use strict';

var _ = require('lodash');
var chai = require('chai');
var expect = chai.expect;
var sinon = require('sinon'); chai.use(require('sinon-chai'));
var azul = require('azul');

var at, req, res, next, db, adapter;
var azulTransaction = require('../index');
var BPromise = require('bluebird');

var Adapter = azul.Adapter.extend({
  init: function() {
    this._super.apply(this, arguments);
    this._failures = [];
    this.clients = [];
    this.executed = [];
  },
  fail: function(sql) {
    this._failures.push(sql);
  },
  _connect: BPromise.method(function() { return this.__identity__.sequence++; }),
  _disconnect: BPromise.method(function(/*client*/) {}),
  _execute: BPromise.method(function(client, sql, args) {
    if (_.contains(this._failures, sql)) {
      throw new Error('Intentional failure for ' + sql);
    }
    return BPromise.delay(1).bind(this).then(function() {
      this.clients = _.uniq(this.clients.concat([client]));
      this.executed.push(args.length ? [sql, args] : sql);
      return { rows: [], fields: [] };
    });
  }),
}, { sequence: 0 });

var pspy = function() {
  var resolve;
  var promise = new BPromise(function() { resolve = arguments[0]; });
  resolve.wait = promise;
  return sinon.spy(resolve);
};

describe('azul-transaction', function() {
  beforeEach(function() {
    adapter = Adapter.create();
    db = azul.Database.create({ adapter: adapter });
    req = {};
    res = {};
    res.end = res._end = pspy();
    res.write = res._write = pspy();
    res.writeHead = res._writeHead = pspy();
    next = pspy();
    at = azulTransaction(db);
  });

  describe('middleware', function() {

    describe('when begun', function() {
      beforeEach(function(done) {
        at(req, res, next);
        next.wait.return().then(done, done);
      });

      it('starts the transaction', function() {
        expect(adapter.executed).to.eql(['BEGIN']);
      });

      it('commits on `end`', function(done) {
        res.end();
        res._end.wait.then(function() {
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN', 'COMMIT']);
        })
        .then(done, done);
      });

      it('calls original `end` with proper args', function(done) {
        res.end('arbitrary', 'argument');
        res.end('again');
        expect(res._end).to.not.have.been.called;
        res._end.wait.then(function() {
          res.end(null);
        })
        .then(function() {
          expect(res._end).to.have.been.calledThrice;
          expect(res._end).to.have.been.calledWithExactly('arbitrary', 'argument');
          expect(res._end).to.have.been.calledWithExactly('again');
          expect(res._end).to.have.been.calledWithExactly(null);
        })
        .then(done, done);
      });

      it('commits on `write`', function(done) {
        res.write();
        res._write.wait.then(function() {
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN', 'COMMIT']);
        })
        .then(done, done);
      });

      it('calls original `write` with proper args', function(done) {
        res.write('arbitrary', 'argument');
        res.write('again');
        expect(res._write).to.not.have.been.called;
        res._write.wait.then(function() {
          res.write(null);
        })
        .then(function() {
          expect(res._write).to.have.been.calledThrice;
          expect(res._write).to.have.been.calledWithExactly('arbitrary', 'argument');
          expect(res._write).to.have.been.calledWithExactly('again');
          expect(res._write).to.have.been.calledWithExactly(null);
        })
        .then(done, done);
      });

      it('commits on `writeHead`', function(done) {
        res.writeHead();
        res._writeHead.wait.then(function() {
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN', 'COMMIT']);
        })
        .then(done, done);
      });

      it('calls original `writeHead` with proper args', function(done) {
        res.writeHead('arbitrary', 'argument');
        res.writeHead('again');
        expect(res._writeHead).to.not.have.been.called;
        res._writeHead.wait.then(function() {
          res.writeHead(null);
        })
        .then(function() {
          expect(res._writeHead).to.have.been.calledThrice;
          expect(res._writeHead).to.have.been.calledWithExactly('arbitrary', 'argument');
          expect(res._writeHead).to.have.been.calledWithExactly('again');
          expect(res._writeHead).to.have.been.calledWithExactly(null);
        })
        .then(done, done);
      });

    });

  });

  describe('error middleware', function() {

    it('performs rollback', function(done) {
      var setup = pspy();
      at(req, res, setup); // setup
      setup.wait.then(function() {
        at.error(new Error('exepcted'), req, res, next);
        return next.wait;
      })
      .then(function() {
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql(['BEGIN', 'ROLLBACK']);
      }).then(done, done);
    });

  });

  describe('wrapped route', function() {

    it('recognizes a next parameter', function() {
      expect(at.route(function(req, res, next) {}).length).to.eql(3);
    });

    it('recognizes an error parameter', function() {
      expect(at.route(function(err, req, res, next) {}).length).to.eql(4);
    });

    it('accepts unknown parameter configurations as standard express params', function() {
      expect(at.route(function(err, req, res, next, bad) {}).length).to.eql(3);
    });

    it('throws for unkown params following azul params', function() {
      expect(function() {
        at.route(function(err, req, res, query, Item, bad) {});
      }).to.throw(/unexpected arguments:.*query, item, bad/i);
    });

    describe('with azul params', function() {
      beforeEach(function() {
        this.route = at.route(function(req, res, next, query, Article) {});
      });

      it('generates a standard express route', function() {
        expect(this.route.length).to.eql(3);
      });
    });

    it('works with middleware installed', function(done) {
      var context = {};
      var setup = pspy(); at(req, res, setup); // setup middleware
      setup.wait.bind(context).then(function() {
        var query;
        var Article;
        var route = at.route(function(req, res, query, Article) {
          context.query = query;
          context.Article = Article;
          query.select('comments').then(function() {
            return Article.objects.fetch();
          })
          .then(function() {
            res.end();
          });
        });
        return route(req, res, next); // invoke route
      })
      .then(function() {
        expect(context.query).to.eql(req.azul.query);
        expect(context.query.transaction()).to.eql(req.azul.transaction);
        expect(context.Article.query).to.eql(req.azul.query);
        expect(adapter.executed).to.eql(['BEGIN']);
        return res._end.wait;
      })
      .then(function() {
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql([
          'BEGIN',
          'SELECT * FROM "comments"',
          'SELECT * FROM "articles"',
          'COMMIT'
        ]);
      })
      .then(done, done);
    });

    it('works without middleware installed', function(done) {
      var context = {};
      BPromise.bind(context).then(function() {
        var query;
        var Article;
        var route = at.route(function(req, res, query, Article) {
          context.query = query;
          context.Article = Article;
          query.select('comments').then(function() {
            return Article.objects.fetch();
          })
          .then(function() {
            res.end();
          });
        });
        return route(req, res, next); // invoke route
      })
      .then(function() {
        expect(context.query).to.eql(req.azul.query);
        expect(context.query.transaction()).to.eql(req.azul.transaction);
        expect(context.Article.query).to.eql(req.azul.query);
        expect(adapter.executed).to.eql(['BEGIN']);
        return res._end.wait;
      })
      .then(function() {
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql([
          'BEGIN',
          'SELECT * FROM "comments"',
          'SELECT * FROM "articles"',
          'COMMIT'
        ]);
      })
      .then(done, done);
    });

    it('works for defining error middleware', function(done) {
      var context = {};
      BPromise.bind(context).then(function() {
        var query;
        var Article;
        var route = at.route(function(err, req, res, next, query, Article) {
          context.query = query;
          context.Article = Article;
          res.end();
        });
        return route(new Error('Error'), req, res, next); // invoke route
      })
      .then(function() {
        expect(context.query).to.eql(req.azul.query);
        expect(context.query.transaction()).to.eql(req.azul.transaction);
        expect(context.Article.query).to.eql(req.azul.query);
        expect(adapter.executed).to.eql(['BEGIN']);
        return res._end.wait;
      })
      .then(function() {
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql(['BEGIN', 'COMMIT']);
      })
      .then(done, done);
    });

    it('performs rollback if next is called with error', function(done) {
      var error = new Error('Expected');
      BPromise.resolve().then(function() {
        var route = at.route(function(req, res, next, query) {
          next(error);
        });
        return route(req, res, next); // invoke route
      })
      .then(function() {
        expect(adapter.executed).to.eql(['BEGIN']);
        return next.wait;
      })
      .then(function() {
        expect(next).to.have.been.calledOnce;
        expect(next).to.have.been.calledWithExactly(new Error('Expected'));
        expect(next.getCall(0).args[0]).to.equal(error);
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql(['BEGIN', 'ROLLBACK']);
      })
      .then(done, done);
    });

    it('performs only performs one rollback if rolled back manually & through error', function(done) {
      BPromise.resolve().then(function() {
        var route = at.route(function(req, res, next, query) {
          res.azul.rollback();
          next(new Error('Expected'));
        });
        return route(req, res, next); // invoke route
      })
      .then(function() {
        return next.wait;
      })
      .then(function() {
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql(['BEGIN', 'ROLLBACK']);
      })
      .then(done, done);
    });

    it('commits if next is called without arguments', function(done) {
      BPromise.resolve().then(function() {
        var route = at.route(function(req, res, next, query) {
          next();
        });
        return route(req, res, next); // invoke route
      })
      .then(function() {
        expect(adapter.executed).to.eql(['BEGIN']);
        return next.wait;
      })
      .then(function() {
        expect(next).to.have.been.calledOnce;
        expect(next).to.have.been.calledWithExactly();
        expect(adapter.clients.length).to.eql(1);
        expect(adapter.executed).to.eql(['BEGIN', 'COMMIT']);
      })
      .then(done, done);
    });

    it('throws if next is called with non-error', function(done) {
      BPromise.resolve().then(function() {
        var route = at.route(function(req, res, next, query) {
          next('value');
        });
        return route(req, res, next); // invoke route
      })
      .then(function() {
        expect(adapter.executed).to.eql(['BEGIN']);
        return next.wait;
      })
      .then(function() {
        expect(next).to.have.been.calledOnce;
        expect(next.getCall(0).args[0]).to.match(/call.*next.*non-error/i);
      })
      .then(done, done);
    });

    describe('when begin transaction fails', function() {
      beforeEach(function() {
        adapter.fail('BEGIN');
      });

      it('calls next with error when transaction fails', function(done) {
        BPromise.bind(context).then(function() {
          var route = at.route(function(req, res, query, Article) {
          });
          return route(req, res, next); // invoke route
        })
        .then(function() {
          return next.wait;
        })
        .then(function() {
          expect(next).to.have.been.calledOnce;
          expect(next.getCall(0).args[0]).to.match(/intentional failure for begin/i);
          expect(adapter.clients.length).to.eql(0);
          expect(adapter.executed).to.eql([]);
        })
        .then(done, done);
      });
    });

    describe('when commit transaction fails', function() {
      beforeEach(function() {
        adapter.fail('COMMIT');
      });

      it('calls next with error when transaction fails', function(done) {
        BPromise.bind(context).then(function() {
          var route = at.route(function(req, res, query, Article) {
            res.end();
          });
          return route(req, res, next); // invoke route
        })
        .then(function() {
          return res.azul.commit();
        })
        .then(function() {
          return next.wait;
        })
        .then(function() {
          expect(next).to.have.been.calledOnce;
          expect(next.getCall(0).args[0]).to.match(/intentional failure for commit/i);
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN']);
        })
        .then(done, done);
      });

    });

    describe('when rollback transaction fails', function() {
      beforeEach(function() {
        adapter.fail('ROLLBACK');
      });

      it('calls next with error when transaction fails', function(done) {
        BPromise.bind(context).then(function() {
          var route = at.route(function(req, res, query, Article) {
            res.azul.rollback();
          });
          return route(req, res, next); // invoke route
        })
        .then(function() {
          return res.azul.rollback();
        })
        .then(function() {
          return next.wait;
        })
        .then(function() {
          expect(next).to.have.been.calledOnce;
          expect(next.getCall(0).args[0]).to.match(/intentional failure for rollback/i);
          expect(adapter.clients.length).to.eql(1);
          expect(adapter.executed).to.eql(['BEGIN']);
        })
        .then(done, done);
      });

    });

  });

});
