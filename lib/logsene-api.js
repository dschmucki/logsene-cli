/* Extract the Logsene API client later in a separate public package */

/*
 * @copyright Copyright (c) Sematext Group, Inc. - All Rights Reserved
 *
 * @licence Logsene CLI is free-to-use, proprietary software.
 * THIS IS PROPRIETARY SOURCE CODE OF Sematext Group, Inc. (Sematext)
 * This source code may not be copied, reverse engineered, or altered for any purpose.
 * This source code is to be used exclusively by users and customers of Sematext.
 * Please see the full license (found in LICENSE in this distribution) for details on its license and the licenses of its dependencies.
 */

/* jshint node:true */
/* global module, process, console, require */
'use strict';

var request         = require('request'),
    esearch         = require('elasticsearch'),
    ReadableSearch  = require('elasticsearch-streams').ReadableSearch,
    VError          = require('verror'),
    out             = require('./util').out,
    isDef           = require('./util').isDef,
    isEmpty         = require('./util').isEmpty,
    stringify       = require('../lib/util').safeJsonStringify;


var logseneEsHost = process.env.LOGSENE_ES_HOST,
    logseneUri = process.env.LOGSENE_URI,
    es;

var initEs = function _initEs(logLevel) {
  es = new esearch.Client({
    host: logseneEsHost,
    log: logLevel || 'error'
  });
};

if (!isDef(es)) initEs();  // do it here so it's ready (not much overhead)


module.exports = {

  initES: initEs,

  /**
   * Retrieves api-key of the user whose
   * username and password are provided as params
   *
   * @param {String} user Logsene account username
   * @param {String} pass Logsene account password
   * @param {Function} cb called upon completion
   * @api public
   */
  login: function _login(user, pass, cb) {
    if (isEmpty(user) || isEmpty(pass)) {
      return cb(new VError('Username or password missing.'));
    }

    var endpoint = logseneUri + '/account/login',

    data = stringify({
      'username': user,
      'password': pass
    }),

    fn = function (err, res, body) {
      if (err) {
        if (err.data) {
          out.trace('Login error.\n' + err.data.toString());  // materialize buffer
        }
        return cb(new VError(err, 'Error while logging in.'));
      }

      if (isDef(res) && res.statusCode == 200) {  // are we good?
        if (!body || !body.data) {
          try {
            body = JSON.parse(body);
          } catch (err) {
            out.trace('Unable to parse response body');
            return cb(new VError('No apiKey in reponse'));
          }
        }

        if (body && body.success) {

          return cb(null, body.data.apiKey);

        } else {
          return cb(new VError('No apiKey in reponse'));
        }

      } else if (res.statusCode !== 200) {
        out.trace('statusCode: ' + res.statusCode + ': ' + res.body);
        return cb(new Error('Login error'));

      } else {
        if (isDef(res)) {  // we got something back, but not 200
          out.trace('Login: Did not get 200 back. Head: ' + JSON.stringify(res.headers));
          out.trace('Body: ' + JSON.stringify(res.body));
          return cb(new VError('HTTP status code: ' + res.statusCode));

        } else {
          return cb(new VError('Something went wrong. No response from the API server.'));
        }
      }
    };

    var options = {
      url: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: data
    };

    request(options, fn);
  },



  /**
   * Retrieves list of Logsene applications
   * that correspond to the provided api-key
   *
   * @param {String} apiKey user account api-key
   * @param {Function} cb(err, data)
   * @api public
   */
  getApps: function _getApps(apiKey, cb) {
    if(isEmpty(apiKey)) {
      return cb(new VError('API key was not supplied.'));
    }

    var endpoint = logseneUri + '/app/list',

    data = stringify({
      'apiKey': apiKey
    }),

    fn = function (err, res, body) {
      if (err) return cb(new VError(err, 'Error while getting Logsene application listing.'));

      if (isDef(res) && res.statusCode == 200) {  // are we good?

        if (!body || !body.data) {
          try {
            body = JSON.parse(body);
          } catch (err) {
            out.trace('Unable to parse response body');
            return cb(new VError('No apps in reponse'));
          }
        }

        if (body && body.success && body.data && body.data.apps && body.data.apps.logsene) {
          out.trace('App listing response body: ' + JSON.stringify(body));
          return cb(null, body.data.apps.logsene);

        } else {
          return cb(new Error('Could not parse the response body to get application listing.'));
        }

      } else {

        if (isDef(res)) {  // we got something back, but not 200
          out.trace('App listing response (!=200) head: ' + JSON.stringify(res.headers));
          out.trace('App listing response (!=200) body: ' + JSON.stringify(res.body));
          return cb(new VError('Something is weird with HTTP status code: ' + res.statusCode));

        } else {  // we didn't get response at all
          return cb(new VError('Something went wrong. No response from the API server.'));
        }
      }
    };

    var options = {
      url: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: data
    };

    request(options, fn);

  },



  /**
   * Sends search query to Logsene
   * Resulting stream is returned in cb's second param
   * First param is err
   * @param {Object} opts search options (see search.js)
   * @param {Function} cb callback with err and a stream of JSON
   * @api public
   */
  search: function _search(opts, cb) {

    // streams all the way down
    var offset = opts.offset;
    var limit  = opts.size;
    var page   = 50;

    var searchExec = function _searchExec(from, esCb) {
      es.search({
        index:              opts.appKey,
        body:               opts.body,
        from:               from + offset,
        size:               (offset + from + page) > limit ? (limit - offset - from) : page,
        fields:             opts.fields,
        ignoreUnavailable:  true
      }, esCb);
    };

    var rs = new ReadableSearch(searchExec);

    cb(null, rs);


/*  // standard, promise based (non-streaming)
    es.search({
      q: opts.q,
      index: opts.appKey/!*,
      ignore: [404]*!/

      // returns a promise
    }).then(function(searchRes) {
      console.log('in then', JSON.stringify(searchRes));
      cb(null, searchRes.hits);

    }, function (searchErr) {
      console.log('in searchErr', searchErr);
      return cb(new VError(searchErr, 'Search request did not succeed!'));
    });
*/

/*  using plain request (without ES client)
    request(options, function(err, res, body) {
      if (!err && res.statusCode == 200) {  // are we good?
        cb(null, body);
      } else {
        if (res == undefined) {  // we're not good
          console.log("Something went wrong: ", err);
        } else {
          console.log("Something went wrong: HTTP status code: " + res.statusCode);
        }
      }
    });
*/

  }


  // TODO idea for later (maybe)
/*
  streamLogEvents: function _streamLogEvents(args, cb) {
    var url = args.hostUrl + "log-stream/" + args.streamId;

    request({uri: url, json: true}, function(err, response, body) {
      if (!err && response.statusCode == 200) {  // we're good
        cb(body)
      } else {
        if (response == undefined) {  // we're not good
          console.log("Something went wrong: Unable to get the log stream!", err)
        } else {
          console.log("Something went wrong: Unable to get the log stream. HTTP error code " + response.statusCode)
        }
      }
    })
  }
*/

};
