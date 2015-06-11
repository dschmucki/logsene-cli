'use strict';
/* jshint node:true */
/* global module, process, console, require */

var osenv = require('osenv'),
    Configstore = require('configstore');

var conf = new Configstore(process.env.SSH_TTY || osenv.user());


module.exports = {

  // TODO IMPORTANT: still missing timestamp check

  /**
   * Defaults:
   * Duration of user's CLI session (m)
   * Max number of hits to return
   */
  logseneEsHost: 'logsene-receiver.sematext.com',
  logseneUri: 'https://apps.sematext.com/users-web/api/v2',
  sessionDuration: 30,
  maxHits: 200,


  /**
   * Used to tidy up set and get commands a bit
   * @returns {string[]} all params
   * @public
   */
  getAvailableParams: function _getAvailableParams() {
    return['api-key', 'app-key', 'app-name', 'trace'];
  },


  /**
   * Gets configuration parameter synchronously
   * @param {String} key
   * @public
   */
  getSync: function _getSync(key) {
    return conf.get(key);
  },


  /**
   * Sets the configuration parameter
   * @param {String} key
   * @param {String} value
   * @public
   */
  setSync: function _setSync(key, value) {
    conf.set(key, value);
  },


  /**
   * Deletes the configuration parameter from the store
   * @param {String} key
   * @public
   */
  deleteSync: function _deleteSync(key) {
    conf.del(key);
  },


  /**
   * Gets all configuration parameters
   * for the current user
   * @returns {*|{get, set}}
   * @public
   */
  getAllSync: function _getAllSync() {
    return conf.all;
  }

};
