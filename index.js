'use strict';

var _ = require('lodash');
var BPromise = require('bluebird');

// TODO: this does not currently work across relationships

var setupRequest = function(db, req) {
  if (req.azul && req.azul.transaction) { return; } // already set up

  var transaction = db.query.transaction();
  var query = db.query.transaction(transaction);
  req.azul = _.extend({}, req.azul, {
    transaction: transaction,
    query: query,
  });
};

var setupResponse = function(db, req, res, next) {
  if (res.azul && res.azul.commit) { return; } // already set up

  var transaction = req.azul.transaction;
  var pending = []; // operations waiting until after commit/rollback
  var closing = false; // has commit/rollback begun?
  var closed = false; // is transaction closed?
  var promise;

  var close = function() {
    closed = true;
    pending.forEach(function(fn) {
      fn();
    });
  };

  var commit = function() {
    if (closing) { return promise; }
    closing = true;
    promise = transaction.commit().execute().then(close).catch(next);
    return promise;
  };

  var rollback = function() {
    if (closing) { return promise; }
    closing = true;
    promise = transaction.rollback().execute().then(close).catch(next);
    return promise;
  };

  var triggerCommit = function(fn) {
    return function() {
      if (!closed) {
        pending.push(fn.apply.bind(fn, this, arguments));
        commit();
      }
      else {
        fn.apply(this, arguments);
      }
    };
  };

  res.writeHead = triggerCommit(res.writeHead);
  res.write = triggerCommit(res.write);
  res.end = triggerCommit(res.end);
  res.azul = _.extend({}, res.azul, {
    commit: commit,
    rollback: rollback,
  });
};

/**
 * Wrap a next function so that it performs a rollback on the transaction if
 * called with an error.
 *
 * @param {Database} db
 * @param {Request} req
 * @param {Response} res
 * @param {Function} next
 * @return {Function}
 */
var wrapNext = function(db, req, res, next) {
  return function() {
    var args = _.toArray(arguments);
    var promise = BPromise.resolve();
    if (!args[0]) {
      promise = res.azul.commit();
    }
    else if (args[0] instanceof Error) {
      promise = res.azul.rollback();
    }
    else {
      throw new Error('Unexpected call to `next` with non-error.');
    }
    return promise.then(next.apply.bind(next, this, args)).catch(next);
  };
};

var middleware = function(db) {
  return function(req, res, next) {
    setupRequest(db, req);
    setupResponse(db, req, res, next);
    req.azul.transaction.begin().then(_.ary(next, 0), next);
  };
};

var errorMiddleware = function(err, req, res, next) {
  res.azul.rollback().return(err).then(next).catch(next);
};

var makeExpressStandardRoute = function(fn) {
  return function(req, res, next) {
    /* jshint unused: false */
    return fn.apply(this, arguments);
  };
};

var makeExpressErrorRoute = function(fn) {
  return function(err, req, res, next) {
    /* jshint unused: false */
    return fn.apply(this, arguments);
  };
};

/**
 * A wrapper for Express routes that binds queries & model classes to the
 * transaction.
 *
 * @param {Database} db The Azul.js database on which bindings should be created.
 * @param {Function} fn The Express route to wrap.
 * @return {Function} The wrapped route.
 */
var route = function(db, fn) {

  var match = fn.toString().match(/function.*?\((.*?)\)/i);
  var params = _.invoke(match[1].split(','), 'trim');
  var isAzulParam = function(arg) { return arg.match(/^([A-Z]\w*|query)$/); };
  var isExpressParam = _.negate(isAzulParam);

  var expressParams = _(params)
    .takeWhile(isExpressParam)
    .value();

  var azulParams = _(params)
    .drop(expressParams.length)
    .takeWhile(isAzulParam)
    .value();

  if (expressParams.length + azulParams.length !== params.length) {
    throw new Error('Unexpected arguments: ' + params.join(', '));
  }

  // argument length is important to express
  var isErrorRoute = (expressParams.length === 4);
  var expressRoute = isErrorRoute ?
    makeExpressErrorRoute :
    makeExpressStandardRoute;

  return expressRoute(function() {
    var args = _.toArray(arguments);
    var referenceArgs = isErrorRoute ? args.slice(1) : args;
    var req = referenceArgs[0];
    var res = referenceArgs[1];
    var next = referenceArgs[2];
    var begun = req.azul && req.azul.transaction;

    setupRequest(db, req);
    setupResponse(db, req, res, next);

    // form express arguments
    var expressArgs = _.take(args, expressParams.length);
    if (expressArgs.length >= 3) {
      expressArgs.splice(-1, 1, wrapNext(db, req, res, next));
    }

    // setup the azul argument, binding queries and model classes
    var query = req.azul.query;
    var azulArgs = azulParams.map(function(arg) {
      return arg === 'query' ? query :
        db.model(arg).extend({}, { query: query });
    });

    // combine args & bind function we're wrapping
    var combinedArgs = [].concat(expressArgs, azulArgs);
    var bound = fn.apply.bind(fn, this, combinedArgs);

    // start the transaction if it wasn't previously begun
    var promise = begun ? BPromise.resolve() : req.azul.transaction.begin();
    return promise.then(bound).catch(next);
  });
};

module.exports = function(db) {
  var dbMiddleware = middleware(db);
  var dbRoute = _.partial(route, db);
  return _.extend(dbMiddleware, {
    route: dbRoute,
    error: errorMiddleware,
  });
};
