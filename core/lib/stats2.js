/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const L = require('lodash');
// const sl = require('stats-lite');
const HdrHistogram = require('hdr-histogram-js');

module.exports = {
  create: create,
  combine: combine,
  round: round,
  deserialize
};

 function deserialize(serialized) {
  const o = JSON.parse(serialized);
  const histos = L.reduce(
    o.encodedHistograms,
    (acc, encodedHisto, name) => {
      acc[name] = HdrHistogram.decodeFromCompressedBase64(encodedHisto);
      return acc;
    },
    {});

  const result = create();
  result._counters = o.counters;
  result._customStats = histos;
  return result;
};


/**
 * Create a new stats object
 */
function create() {
  return new Stats();
}

/**
 * Combine several stats objects from different workers into one
 */
function combine(statsObjects) {
  let result = create();

  L.each(statsObjects, function(stats) {
    L.each(stats._counters, function(value, name) {
      if (!result._counters[name]) {
        result._counters[name] = 0;
      }
      result._counters[name] += value;
    });

    L.each(stats._customStats, (histo, name) => {
      if(!result._customStats[name]) {
        // TODO: DRY
        result._customStats[name] = HdrHistogram.build({
          bitBucketSize: 64,
          autoResize: true,
          lowestDiscernibleValue: 2,
          highestTrackableValue: 1e12,
          numberOfSignificantValueDigits: 1
        });
      }

      result._customStats[name].add(histo);
    });
  });

  return result;
}

function Stats() {
  return this.reset();
}

Stats.prototype.clone = function() {
  return L.cloneDeep(this);
};

Stats.prototype.report = function() {
  let result = {};

  result.timestamp = new Date().toISOString();
  result.scenariosCreated = this._counters['scenarios.created'];

  result.scenarioCounts = {};
  L.each(this._counters, (count, name) => {
    if (name.startsWith('scenarios.created.')) {
      const scname = name.split('scenarios.created.')[1];
      result.scenarioCounts[scname] = count;
    }
  });

  result.scenariosCompleted = this._counters['scenarios.completed'];
  result.requestsCompleted = this._counters['engine.http.responses_received'];

  const ns = this._customStats['engine.http.response_time'];

  result.latency = {
    min: round(ns.minNonZeroValue, 1),
    max: round(ns.maxValue, 1),
    median: round(ns.getValueAtPercentile(50), 1),
    p95: round(ns.getValueAtPercentile(95), 1),
    p99: round(ns.getValueAtPercentile(99), 1)
  };

  result.rps = {
    count: result.requestsCompleted,
    mean: result.requestsCompleted / 10 // FIXME: depends on the period...
  };

  result.errors = {}; // retain as an object
  L.each(this._counters, (count, name) => {
    if (name.startsWith('errors.')) {
      const errCode = name.split('errors.')[1];
      result.errors[errCode] = count;
    }
  });

  result.codes = {};
  L.each(this._counters, (count, name) => {
    if (name.startsWith('engine.http.response_code')) {
      const code = name.split('response_code.')[1];
      result.codes[code] = count;
    }
  });

  result.matches = this._counters['matches'];

  result.customStats = {};
  L.each(this._customStats, function(ns, name) {
    result.customStats[name] = {
      min: round(ns.minNonZeroValue, 1),
      max: round(ns.maxValue, 1),
      median: round(ns.getValueAtPercentile(50), 1),
      p75: round(ns.getValueAtPercentile(75), 1),
      p95: round(ns.getValueAtPercentile(95), 1),
      p99: round(ns.getValueAtPercentile(99), 1)
    };
  });
  result.counters = this._counters;

  result.scenariosAvoided = this._counters['scenarios.skipped'];

  return result;
};

Stats.prototype.addCustomStat = function(name, n) {
  // TODO: Should below be configurable / does it need tweaked?
  if (!this._customStats[name]) {
    this._customStats[name] = HdrHistogram.build({
      bitBucketSize: 64,
      autoResize: true,
      lowestDiscernibleValue: 2,
      highestTrackableValue: 1e12,
      numberOfSignificantValueDigits: 1
    });
  }

  this._customStats[name].recordValue(n); // ns, ms conversion happens later
  return this;
};

Stats.prototype.counter = function(name, value) {
  if (!this._counters[name]) {
    this._counters[name] = 0;
  }
  this._counters[name] += value;
  return this;
};

Stats.prototype.reset = function() {
  this._customStats = {};
  this._counters = {};
  return this;
};

Stats.prototype.serialize = function() {
  this._encodedHistograms = {};
  L.each(this._customStats, (histo, name) => {
    this._encodedHistograms[name] = HdrHistogram.encodeIntoBase64String(histo);
  });

  return JSON.stringify({
    counters: this._counters,
    encodedHistograms: this._encodedHistograms
  });
};

Stats.prototype.free = function() {
  return this;
};

function round(number, decimals) {
  const m = Math.pow(10, decimals);
  return Math.round(number * m) / m;
}
