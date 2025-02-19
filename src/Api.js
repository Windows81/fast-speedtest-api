const https = require('https');
const http = require('http');
const HttpsProxyAgent = require('https-proxy-agent');
const url = require('url');
const Timer = require('./Timer');
const ApiError = require('./ApiError');

const DEFAULT_SPEEDTEST_TIMEOUT = 5000; // ms
const DEFAULT_URL_COUNT = 5;
const DEFAULT_BUFFER_SIZE = 8;
const MAX_CHECK_INTERVAL = 200; // ms

class Api {
  /**
   * Create an Api object
   *
   * @param {object} options {token<string>, [verbose<boolean>, timeout<number>,
   * https<boolean>, urlCount<number>, bufferSize<number>, unit<function>]}
   */
  constructor(options) {
    if (!options) {
      throw new Error('You must define options in Api constructor');
    }

    if (!options.token) {
      throw new Error('You must define app token');
    }

    if (options.unit && typeof options.unit !== 'function') {
      throw new Error('Invalid unit');
    }

    if (options.proxy) {
      this.proxy = new HttpsProxyAgent(options.proxy);
    }

    this.token = options.token;
    this.verbose = options.verbose || false;
    this.timeout = options.timeout || DEFAULT_SPEEDTEST_TIMEOUT;
    this.https = options.https == null ? true : Boolean(options.https);
    this.urlCount = options.urlCount || DEFAULT_URL_COUNT;
    this.bufferSize = options.bufferSize || DEFAULT_BUFFER_SIZE;
    this.unit = options.unit || Api.UNITS.Bps;
  }


  /**
   * Compute average from array of number
   *
   * @static
   * @param {Array} arr array of number or null
   * @return {number} The average
   */
  static average(arr) {
    // remove nulls from list
    const arrWithoutNulls = arr.filter(e => e);
    if (arrWithoutNulls.length === 0) {
      return 0;
    }
    return arrWithoutNulls.reduce((a, b) => a + b) / arrWithoutNulls.length;
  }


  /**
   * Get data from the specified URL
   *
   * @async
   * @param {string} options The http/s get options to download from
   * @return {Promise} The request and response from the URL
   */
  async get(options) {
    return new Promise((resolve, reject) => {
      const request = (this.https ? https : http).get(options, (response) => {
        if (response.headers['content-type'].includes('json')) {
          response.setEncoding('utf8');
          let rawData = '';
          response.on('data', (chunk) => {
            rawData += chunk;
          });
          response.on('end', () => {
            const parsedData = JSON.parse(rawData);
            response.data = parsedData;
            resolve({
              response,
              request,
            });
          });
        } else {
          resolve({
            response,
            request,
          });
        }
      }).on('error', (e) => {
        reject(e);
      });
    });
  }


  /**
   * Get videos to download url from Fast api
   *
   * @async
   * @return {Array<string>} List of videos url
   */
  async getTargets() {
    try {
      const targets = [];
      while (targets.length < this.urlCount) {
        const target = `http${this.https ? 's' : ''}://api.fast.com/netflix/speedtest?https=${this.https ? 'true' : 'false'}&token=${this.token}&urlCount=${this.urlCount - targets.length}`;
        const options = url.parse(target);
        if (this.proxy) options.agent = this.proxy;
        /* eslint-disable no-await-in-loop */
        const { response } = await this.get(options);
        /* eslint-enable no-await-in-loop */
        if (response.statusCode !== 200) {
          if (response.statusCode === 403) {
            throw new ApiError({ code: ApiError.CODES.BAD_TOKEN });
          }
          if (response.statusCode === 407) {
            throw new ApiError({ code: ApiError.CODES.PROXY_NOT_AUTHENTICATED });
          }
          console.log(response.statusCode);
          throw new ApiError({ code: ApiError.CODES.UNKNOWN });
        }
        targets.push(...response.data);
      }
      return targets.map(target => target.url);
    } catch (e) {
      if (e.code === 'ENOTFOUND') {
        if (this.https) {
          throw new ApiError({ code: ApiError.CODES.UNREACHABLE_HTTPS_API });
        } else {
          throw new ApiError({ code: ApiError.CODES.UNREACHABLE_HTTP_API });
        }
      } else {
        throw e;
      }
    }
  }

  /**
   * Resolves when timeout or when the first video finished downloading
   *
   * @returns {Promise<number>} Speed in selected unit (Default: Bps)
   */
  async getSpeed() {
    let targets = null;
    try {
      targets = await this.getTargets();
    } catch (e) {
      throw e;
    }

    let bytes = 0;
    const requestList = [];

    const timer = new Timer(this.timeout, () => {
      requestList.forEach(r => r.abort());
    });

    targets.forEach(async (target) => {
      const {response, request} = await this.get(target);
      requestList.push(request);
      response.on('data', (data) => {
        bytes += data.length;
      });
      response.on('end', () => {
        // when first video is downloaded
        timer.stop(); // stop timer and execute timer callback
      });
    });

    return new Promise((resolve) => {
      let i = 0;
      const recents = new Array(this.bufferSize).fill(null); // list of most recent speeds
      const interval = Math.min(
        this.timeout / this.bufferSize,
        MAX_CHECK_INTERVAL,
      ); // ms
      const refreshIntervalId = setInterval(() => {
        i = (i + 1) % recents.length; // loop through recents
        recents[i] = bytes / (interval / 1000); // add most recent bytes/second

        if (this.verbose) {
          console.log(`Current speed: ${this.unit(this.constructor.average(recents))} ${this.unit.name}`);
        }

        bytes = 0;// reset bytes count
      }, interval);

      timer.addCallback(() => {
        clearInterval(refreshIntervalId);
        resolve(this.unit(this.constructor.average(recents)));
      });

      timer.start();
    });
  }
}

Api.UNITS = {
  // rawSpeed is in B/s
  "B/s": rawSpeed => rawSpeed,
  "KB/s": rawSpeed => rawSpeed / 1000,
  "MB/s": rawSpeed => rawSpeed / 1000 / 1000,
  "GB/s": rawSpeed => rawSpeed / 1000 / 1000 / 1000,

  "KiB/s": rawSpeed => rawSpeed / 1024,
  "MiB/s": rawSpeed => rawSpeed / 1024 / 1024,
  "GiB/s": rawSpeed => rawSpeed / 1024 / 1024 / 1024,
  
  "b/s": rawSpeed => rawSpeed * 8,
  "Kb/s": rawSpeed => (rawSpeed * 8) / 1000,
  "Mb/s": rawSpeed => (rawSpeed * 8) / 1000 / 1000,
  "Gb/s": rawSpeed => (rawSpeed * 8) / 1000 / 1000 / 1000,

  "Kib/s": rawSpeed => (rawSpeed * 8) / 1024,
  "Mib/s": rawSpeed => (rawSpeed * 8) / 1024 / 1024,
  "Gib/s": rawSpeed => (rawSpeed * 8) / 1024 / 1024 / 1024,
};

Object.entries(Api.UNITS).forEach(([i, v]) => {
  Api.UNITS[i.replace("/", "p")] = v; // for example, "MB/s" to "MBps"
})

module.exports = Api;
