# Azul.js Express Transaction Middleware

[![NPM version][npm-image]][npm-url] [![Build status][travis-image]][travis-url] [![Code Climate][codeclimate-image]][codeclimate-url] [![Coverage Status][coverage-image]][coverage-url] [![Dependencies][david-image]][david-url] [![devDependencies][david-dev-image]][david-dev-url]

Simplify use of [transactions][azul-transactions] on a per-request basis when
using [Azul.js][azul] with Express. For more information, see the
[Azul.js transaction guide][azul-transactions].

```js
app.post('/articles', at.route(function(req, res, next, Article, Author) {
  Author.objects.findOrCreate({ name: req.body.author }).then(function(author) {
    return author.createArticle({ title: req.body.title }).save();
  })
  .then(function(article) {
    res.send({ article: article.json });
  })
  .catch(next);
}));
```

For reference, the full setup for the above example would look something like this:

```js
var express = require('express');
var app = express();
var bodyParser = require('body-parser');
var BPromise = require('bluebird');

var azul = require('azul');
var env = process.env.NODE_ENV || 'development';
var config = require('./azulfile')[env];
var db = azul(config);
var at = require('azul-transaction')(db);

db.model('Article', {
  title: db.attr(),
  author: db.belongsTo(),
});

db.model('Author', {
  name: db.attr(),
  articles: db.hasMany(),
});

app.use(bodyParser.urlencoded());

// insert above code here
```

## API

### azulTransaction(db)

#### db

Type: `Database`

The database from which to create transactions.


## License

This project is distributed under the MIT license.

[azul]: http://www.azuljs.com/
[azul-transactions]: http://www.azuljs.com/guides/transactions/

[travis-image]: http://img.shields.io/travis/wbyoung/azul-transaction.svg?style=flat
[travis-url]: http://travis-ci.org/wbyoung/azul-transaction
[npm-image]: http://img.shields.io/npm/v/azul-transaction.svg?style=flat
[npm-url]: https://npmjs.org/package/azul-transaction
[codeclimate-image]: http://img.shields.io/codeclimate/github/wbyoung/azul-transaction.svg?style=flat
[codeclimate-url]: https://codeclimate.com/github/wbyoung/azul-transaction
[coverage-image]: http://img.shields.io/coveralls/wbyoung/azul-transaction.svg?style=flat
[coverage-url]: https://coveralls.io/r/wbyoung/azul-transaction
[david-image]: http://img.shields.io/david/wbyoung/azul-transaction.svg?style=flat
[david-url]: https://david-dm.org/wbyoung/azul-transaction
[david-dev-image]: http://img.shields.io/david/dev/wbyoung/azul-transaction.svg?style=flat
[david-dev-url]: https://david-dm.org/wbyoung/azul-transaction#info=devDependencies
