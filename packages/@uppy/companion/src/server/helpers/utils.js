const request = require('request')
const { URL } = require('url')
const crypto = require('crypto')
const { getProtectedHttpAgent, getRedirectEvaluator } = require('./request')
const Jsftp = require('jsftp')
const UrlParse = require('url-parse')
const Mime = require('mime-types')

/**
 *
 * @param {string} value
 * @param {string[]} criteria
 * @returns {boolean}
 */
exports.hasMatch = (value, criteria) => {
  return criteria.some((i) => {
    return value === i || (new RegExp(i)).test(value)
  })
}

/**
 *
 * @param {object} data
 * @returns {string}
 */
exports.jsonStringify = (data) => {
  const cache = []
  return JSON.stringify(data, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (cache.indexOf(value) !== -1) {
        // Circular reference found, discard key
        return
      }
      cache.push(value)
    }
    return value
  })
}

/**
 * Does a simple html sanitization on the passed value
 *
 * @param {string} text
 */
exports.sanitizeHtml = (text) => {
  return text ? text.replace(/<\/?[^>]+(>|$)/g, '') : text
}

/**
 * Gets the size and content type of a url's content
 *
 * @param {string} url
 * @param {boolean=} blockLocalIPs
 * @return {Promise}
 */
exports.getURLMeta = (url, blockLocalIPs = false) => {
  if (url.indexOf('ftp') === 0 || url.indexOf('sftp') === 0) {
    return new Promise((resolve, reject) => {
      const {
        host,
        port,
        user,
        pass,
        filePath
      } = parseFtpUrl(url)

      const ftpClient = new Jsftp({
        host: host,
        port: port,
        user: user,
        pass: pass
      })

      ftpClient.raw('size', filePath, function (err, data) {
        if (err) {
          err = err || new Error('Unexpected exception')
          reject(err)
        }
        resolve({
          type: Mime.lookup(filePath),
          size: parseInt(data.text.split(' ')[1])
        })
      })
    })
  } else {
    return new Promise((resolve, reject) => {
      const opts = {
        uri: url,
        method: 'HEAD',
        followRedirect: getRedirectEvaluator(url, blockLocalIPs),
        agentClass: getProtectedHttpAgent((new URL(url)).protocol, blockLocalIPs)
      }

      request(opts, (err, response) => {
        if (err || response.statusCode >= 300) {
          // @todo possibly set a status code in the error object to get a more helpful
          // hint at what the cause of error is.
          err = err || new Error(`URL server responded with status: ${response.statusCode}`)
          reject(err)
        } else {
          resolve({
            type: response.headers['content-type'],
            size: parseInt(response.headers['content-length'])
          })
        }
      })
    })
  }
}

// all paths are assumed to be '/' prepended
/**
 * Returns a url builder
 *
 * @param {object} options companion options
 */
module.exports.getURLBuilder = (options) => {
  /**
   * Builds companion targeted url
   *
   * @param {string} path the tail path of the url
   * @param {boolean} isExternal if the url is for the external world
   * @param {boolean=} excludeHost if the server domain and protocol should be included
   */
  const buildURL = (path, isExternal, excludeHost) => {
    let url = path
    // supports for no path specified too
    if (isExternal) {
      url = `${options.server.implicitPath || ''}${url}`
    }

    url = `${options.server.path || ''}${url}`

    if (!excludeHost) {
      url = `${options.server.protocol}://${options.server.host}${url}`
    }

    return url
  }

  return buildURL
}

/**
 * Ensure that a user-provided `secret` is 32 bytes long (the length required
 * for an AES256 key) by hashing it with SHA256.
 *
 * @param {string|Buffer} secret
 */
function createSecret (secret) {
  const hash = crypto.createHash('sha256')
  hash.update(secret)
  return hash.digest()
}

/**
 * Create an initialization vector for AES256.
 *
 * @return {Buffer}
 */
function createIv () {
  return crypto.randomBytes(16)
}

function urlEncode (unencoded) {
  return unencoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '~')
}

function urlDecode (encoded) {
  encoded = encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/~/g, '=')
  return encoded
}

/**
 * Encrypt a buffer or string with AES256 and a random iv.
 *
 * @param {string} input
 * @param {string|Buffer} secret
 * @return {string} Ciphertext as a hex string, prefixed with 32 hex characters containing the iv.
 */
module.exports.encrypt = (input, secret) => {
  const iv = createIv()
  const cipher = crypto.createCipheriv('aes256', createSecret(secret), iv)
  let encrypted = cipher.update(input, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  // add iv to encrypted string to use for decryption
  return iv.toString('hex') + urlEncode(encrypted)
}

/**
 * Decrypt an iv-prefixed or string with AES256. The iv should be in the first 32 hex characters.
 *
 * @param {string} encrypted
 * @param {string|Buffer} secret
 * @return {string} Decrypted value.
 */
module.exports.decrypt = (encrypted, secret) => {
  // Need at least 32 chars for the iv
  if (encrypted.length < 32) {
    throw new Error('Invalid encrypted value. Maybe it was generated with an old Companion version?')
  }

  const iv = Buffer.from(encrypted.slice(0, 32), 'hex')
  const encryptionWithoutIv = encrypted.slice(32)
  const decipher = crypto.createDecipheriv('aes256', createSecret(secret), iv)
  let decrypted = decipher.update(urlDecode(encryptionWithoutIv), 'base64', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

const parseFtpUrl = (url) => {
  const urlData = UrlParse(url)

  return {
    host: urlData.host,
    port: urlData.port ? urlData.port : 21,
    user: urlData.username,
    pass: urlData.password,
    filePath: urlData.pathname
  }
}
module.exports.parseUrl = parseFtpUrl
