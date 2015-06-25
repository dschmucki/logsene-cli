'use strict';
/* jshint node:true */
/* global module, process, console, require */

// not ideal place, but circular dependency otherwise
require('../lib/bootstrap');  // throw away, just bootstrap

var Command         = require('ronin').Command,
    ejs             = require('elastic.js'),
    values          = require('lodash.values'),
    forEach         = require('lodash.foreach'),
    Transform       = require('stream').Transform,
    JSONStream      = require('JSONStream'),
    eos             = require('end-of-stream'),
    argv            = require('../lib/util').argv,
    out             = require('../lib/util').out,
    isDef           = require('../lib/util').isDef,
    isStrOrBoolTrue = require('../lib/util').isStrOrBoolTrue,
    stringify       = require('../lib/util').safeJsonStringify,
    warnAndExit     = require('../lib/util').warnAndExit,
    parseTime       = require('../lib/time').parse,
    disallowedChars = require('../lib/time').disallowedChars,
    conf            = require('../lib/config'),
    api             = require('../lib/logsene-api');

var nl = '\n';

/**
 * Assembles ejs filter according to query entered by the user
 * It checks whether user expressed time component and, if yes,
 * composes the filter accordingly
 * @returns assembled ejs filter
 * @private
 */
var getTimeFilterSync = function _getTimeFilterSync() {
  var filter;

  // first check whether user provided the time component (--t)
  if (!argv.t) {
    // when not specified, default time is the last 60m
    var millisInHour      = 3600000,
        nowMinusHour      = Date.now() - millisInHour,
        defaultStartTime  = (new Date(nowMinusHour)).toISOString();

    filter = ejs.RangeFilter('@timestamp').gte(defaultStartTime);

  } else {

    // datetime param provided
    var t = argv.t,
        argvSep = argv.sep,
        confSep = conf.getSync('rangeSeparator'),
        sep = argvSep ? argvSep : (confSep ? confSep : '/');

    out.trace('Range separator for this session: ' + sep);

    if (disallowedChars.indexOf(sep) > -1)
      warnAndExit(sep + ' is not allowed as a range separator. That\'s because it' + nl +
          'clashes with standard ISO 8601 datetime or duration notation' + nl +
          'The default separator, forward slash, should be used.' + nl +
          'It is also possible to use a custom separator (e.g. \' TO \').' + nl +
          'Disallowed chars: ' + disallowedChars.join(', ') + '' + nl +
          'e.g. logsene config set --sep TO', Search);


    // we get back {start: Date[, end: Date]} and that's all we care about
    var parsed = parseTime(t, {separator: sep});

    if (parsed) {
      filter = ejs.RangeFilter('@timestamp').gte(parsed.start);
      if (isDef(parsed.end)) {  // if range, add the 'end' condition to the filter
        filter = filter.lte(parsed.end);
      }
    } else {
      warnAndExit('Unrecognized datetime format.', Search);
    }
  }

  out.trace('getTimeFilterSync returning:' + nl + stringify(filter.toJSON()));
  return filter;
};


var Search = Command.extend({ use: ['session', 'auth'],
  desc: 'Search Logsene logs',

  run: function _run() {
    out.trace('Called with arguments: ' + stringify(argv));

    // any number of params is allowed
    if (argv._.length === 2) {
      // if no -q use first command after search as q
      // so 'logsene search <query>' works as expected
      argv.q = argv._[1];
    }


    var opts = {
      appKey:   conf.getSync('appKey'),
      size:     argv.s || conf.getSync('defaultSize') || conf.maxHits,
      offset:   argv.o || 0,
      logLevel: isStrOrBoolTrue(conf.getSync('trace')) ? 'trace' : 'error',
      body:     ejs.Request()
                  .query(ejs.FilteredQuery(getQuerySync(), getTimeFilterSync()))
                  .sort('@timestamp', 'asc')
    };

    out.trace('Search: sending to logsene-api:' + nl + stringify(opts));

    // logsene-api:
    api.search(opts, function(err, esReadableHits) {
      if(err) {
        out.error('Search error: ' + err.message);
        process.exit(1); // bail out
      }

      var jsonExtractor = new Transform({objectMode: true}),
          tsvExtractor = new Transform({objectMode: true}),
          hitCnt = 0;

      jsonExtractor._transform = function _jsonTransform(data, encoding, next) {
        var source = isDef(data['_source']) ? data['_source'] : data;

        this.push(source);
        hitCnt++;
        next();
      };


      tsvExtractor._transform = function _tsvTransform(data, encoding, next) {
        var source = isDef(data['_source']) ? data['_source'] : data;
        var output = '';

        forEach(values(source), function _forEachValue(v) {
          output += v + '\t';
        });

        this.push(output + '\n');
        hitCnt++;  // counting objects = hits
        next();
      };

      eos(esReadableHits, function _esReadableHits(err) {
        if (err) {
          out.error('ES stream had an error or closed early.');
          process.exit(1);
        }

        // only show when trace is turned on or there are no hits (messes up the ability to pipe output)
        var maxHits = conf.maxHits;
        if (hitCnt === 0) {
          out.info('\nReturned hits: ' + hitCnt + (hitCnt === maxHits ? ' (max)' : ''));
        } else {
          out.trace('\nReturned hits: ' + hitCnt + (hitCnt === maxHits ? ' (max)' : ''));
        }
        process.exit(0);
      });


      if (argv.json) {
        esReadableHits
            .pipe(jsonExtractor)
            .pipe(JSONStream.stringify(false))
            .pipe(process.stdout);

      } else {
        esReadableHits
            .pipe(tsvExtractor)
            .pipe(process.stdout);
      }

    });
  },


  help: function _help() {
    return 'Usage: logsene ' + this.name + ' query [OPTIONS]' + nl +
    '  where OPTIONS may be:' + nl +
    '    --q <query>        Query string (--q parameter can be omitted)' + nl +
    '    --op AND           OPTIONAL Overrides default OR operator' + nl +
    '    --t <interval>     OPTIONAL ISO 8601 datetime or duration or time range' + nl +
    '    --s <size>         OPTIONAL Number of matches to return. Defaults to ' + conf.maxHits + '' + nl +
    '    --o <offset>       OPTIONAL Number of matches to skip from the beginning. Defaults to 0' + nl +
    '    --json             OPTIONAL Returns JSON instead of TSV' + nl +
    '    --sep              OPTIONAL Sets the separator between two datetimes when specifying time range' + nl +
    nl +
    'Examples:' + nl +
    '  logsene ' + this.name + '' + nl +
    '      returns last 1h of log entries' + nl +
    nl +
    '  logsene ' + this.name + ' --q ERROR' + nl +
    '      returns last 1h of log entries that contain the term ERROR' + nl +
    nl +
    '  logsene ' + this.name + ' ERROR' + nl +
    '      equivalent to the previous example' + nl +
    nl +
    '  logsene ' + this.name + ' UNDEFINED SEGFAULT' + nl +
    '      returns last 1h of log entries that have either of the terms' + nl +
    '      note: default operator is OR' + nl +
    nl +
    '  logsene ' + this.name + ' SEGFAULT Segmentation --op AND' + nl +
    '      returns last 1h of log entries that have both terms' + nl +
    '      note: convenience parameter --and has the same effect' + nl +
    nl +
    '  logsene ' + this.name + ' --q "Server not responding"' + nl +
    '      returns last 1h of log entries that contain the given phrase' + nl +
    nl +
    '  logsene ' + this.name + ' --t 1y8M4d8h30m2s' + nl +
    '      returns all the log entries reaching back to' + nl +
    '      1 year 8 months 4 days 8 hours 30 minutes and 2 seconds' + nl +
    '      note: any datetime component can be omitted (shown in the following two examples)' + nl +
    '      note: months must be specified with uppercase M (distinction from minutes)' + nl +
    nl +
    '  logsene ' + this.name + ' --t 1h30m' + nl +
    '      returns all the log entries from the last 1,5h' + nl +
    nl +
    '  logsene ' + this.name + ' --t 90' + nl +
    '      equivalent to the previous example (default time unit is minute)' + nl +
    nl +
    '  logsene ' + this.name + ' --t 2015-06-20T20:48' + nl +
    '      returns all the log entries that were logged after the provided datetime' + nl +
    '      note: allowed formats listed at the bottom of this help message' + nl +
    nl +
    '  logsene ' + this.name + ' --t "2015-06-20 20:28"' + nl +
    '      returns all the log entries that were logged after the provided datetime' + nl +
    '      note: if a parameter contains spaces, it must be enclosed in quotes' + nl +
    nl +
    '  logsene ' + this.name + ' --t 2015-06-16T22:27:41/2015-06-18T22:27:41' + nl +
    '      returns all the log entries that were logged between provided timestamps' + nl +
    '      note: date range must either contain forward slash between datetimes,' + nl +
    '            or a different range separator must be specified (shown in the next example)' + nl +
    nl +
    '  logsene ' + this.name + ' --t "2015-06-16T22:27:41 TO 2015-06-18T22:27:41" --sep " TO "' + nl +
    '      same as previous command, except it sets the custom string separator that denotes a range' + nl +
    '      note: default separator is the forward slash (as per ISO-8601)' + nl +
    '      note: if a parameter contains spaces, it must be enclosed in quotes' + nl +
    nl +
    '  logsene ' + this.name + ' --t "last Friday at 13:00/last Friday at 13:30"' + nl +
    '      it is also possible to use "human language" to designate datetime' + nl +
    '      note: it may be used in place of datetime (e.g. "last friday between 12 and 14" is not allowed)' + nl +
    '      note: may yield unpredictable datetime values' + nl +
    nl +
    '  logsene ' + this.name + ' --q ERROR --s 20' + nl +
    '      returns at most 20 latest log entries with the term ERROR' + nl +
    nl +
    '  logsene ' + this.name + ' ERROR --s 50 --o 20' + nl +
    '      returns chronologically sorted hits 21st to 71st (offset=20)' + nl +
    '      note: default sort order is ascending (for convenience - latest on the bottom)' + nl +
    nl +
    '  logsene ' + this.name + ' --help' + nl +
    '      outputs this usage information' + nl +
    nl +
    'Allowed datetime formats:' + nl +
    '  YYYY[-]MM[-]DD[T][HH[:MM[:SS]]]' + nl +
    '  e.g.' + nl +
    '    YYYY-MM-DD HH:mm:ss' + nl +
    '    YYYY-MM-DDTHH:mm' + nl +
    '    YYYY-MM-DDHH:mm' + nl +
    '    YYYYMMDDTHH:mm' + nl +
    '    YYYYMMDD HH:mm' + nl +
    '    YYYYMMDDHH:mm' + nl +
    '    YYYYMMDDHHmm' + nl +
    '  note: to use UTC instead of local time, append Z to datetime' + nl +
    '  note: all datetime components are optional except date (YYYY, MM and DD)' + nl +
    '        If not specified, component defaults to its lowest possible value' + nl +
    '  note: date part may be separated from time by T (ISO-8601), space or nothing at all' + nl +
    nl +
    'Allowed duration format:' + nl +
    '  [Ny][NM][Nd][Nh][Nm][Ns]' + nl +
    '  e.g.' + nl +
    '    1M1d42s' + nl +
    '  note: duration is specified as a series of number and time designator pairs, e.g. 1y2M8d22h8m48s' + nl +
    nl +
    'Allowed datetime range formats' + nl +
    '  range can be expressed in two ways, with datetime/datetime or with datetime/duration:' + nl +
    '  datetime/datetime' + nl +
    '  datetime/{+|-}duration' + nl +
    '  where / is default range separator string and + or - sign is duration designator (examples listed below)' + nl +
    '    plus  (+) duration designator means that filter\'s end time will be constructed by adding duration to start time' + nl +
    '    minus (-) means that start time will be datetime - duration and end time will be what used to be start time' + nl +
    '    YYYY[-]MM[-]DD[T][HH[:MM[:SS]]]/YYYY[-]MM[-]DD[T][HH[:MM[:SS]]]' + nl +
    '    YYYY[-]MM[-]DD[T][HH[:MM[:SS]]]/+[Ny][NM][Nd][Nh][Nm][Ns]' + nl +
    '  e.g.' + nl +
    '    2015-06-23 17:45/2015-06-23 18:45' + nl +
    '    2015-06-23 17:45/-1M' + nl +
    '        gets translated to: 2015-05-23 17:45/2015-06-23 17:45' + nl +
    '    2015-06-23 17:45/+15m' + nl +
    '        gets translated to: 2015-06-23 17:45/2015-06-23 18:00' + nl +
    '  note: all allowable datetime formats are also permitted when specifying ranges' + nl +
    '  note: disallowed range separators:' + nl +
    '       ' + disallowedChars.join(', ') + nl +
    nl +
    'Allowed "human" formats:' + nl +
    '  10 minutes ago' + nl +
    '  yesterday at 12:30pm' + nl +
    '  last night (night becomes 19:00)' + nl +
    '  last month' + nl +
    '  last friday at 2pm' + nl +
    '	 in 3 hours' + nl +
    '	 tomorrow night at 5' + nl +
    '	 wednesday 2 weeks ago' + nl +
    '	 in 2 months' + nl +
    '	 next week saturday morning (morning becomes 06:00)' + nl +
    '  e.g.' + nl +
    '    1M1d42s' + nl +
    '  note: duration is specified as a series of number and time designator pairs, e.g. 1y2M8d22h8m48s' + nl +
    nl +
    '--------';
  }
});


/**
 * Assembles ejs query according to query entered by the user
 * It checks whether user entered just one term, multi-term or a phrase?
 * @returns assembled ejs query
 * @private
 */
var getQuerySync = function _getQuery() {
  var query;

  if (argv._.length === 1) {
    // if client just entered 'logsene search'
    // give him back all log entries (from the last hour - getTimeSync)
    query = ejs.MatchAllQuery();

  } else if (argv._.length === 2) {
    // if query is a single word or a phrase in quotes
    // for phrase, make sure that qoutes ar visible in the query
    var q;
    if (argv._[1].indexOf(' ') > -1) {  // phrase
      q = '"' + argv._[1] + '"';
    } else {                            // single word
      q = argv._[1];
    }
    query = ejs.QueryStringQuery().query(q).defaultOperator(getOperator());

  } else if (argv._.length > 2) {
    // if query has multiple words, without quotes, treat it as normal OR query
    var qMulti = argv._.slice(1).join(' ');
    query = ejs.QueryStringQuery().query(qMulti).defaultOperator(getOperator());
  }

  out.trace('Returning query from getQuerySync:' + nl + stringify(query.toJSON()));
  return query;
};


/**
 * Returns AND operator if explicitly specified by the user
 * Otherwise returns default OR
 * @returns {String} Operator
 * @private
 */
var getOperator = function _getOperator() {
  if (argv.and || (isStrOrBoolTrue(argv.op) && argv.op === 'and')) {
    return 'and';
  } else {
    return 'or';
  }
};


module.exports = Search;
