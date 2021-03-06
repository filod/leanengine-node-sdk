var connect = require('connect'),
  bodyParser = require('body-parser'),
  https = require('https'),
  domain = require('domain'),
  crypto = require('crypto'),
  AV = require('./av-extra'),
  utils = require('./utils');
  avosExpressCookieSession = require('./avosExpressCookieSession'),
  avosExpressHttpsRedirect = require('./avosExpressHttpsRedirect'),
  debug = require('debug')('AV:LeanEngine');

if (process.env.LC_API_SERVER) {
  AV.serverURL = process.env.LC_API_SERVER;
}
var NODE_ENV = process.env.NODE_ENV || 'development';
AV.Cloud.__prod = NODE_ENV === 'production' ? 1 : 0;

if (!AV._old_Cloud) {
  AV._old_Cloud = AV.Cloud;
  var Cloud = AV.Cloud = connect();
  for (var key in AV._old_Cloud) {
    Cloud[key] = AV._old_Cloud[key];
  }
}

// Don't reject unauthorized ssl.
if (https.globalAgent && https.globalAgent.options) {
  https.globalAgent.options.rejectUnauthorized = false;
}

AV.Cloud.CookieSession = avosExpressCookieSession(AV);
AV.Cloud.HttpsRedirect = avosExpressHttpsRedirect(AV);

// 健康监测 router
Cloud.use('/__engine/1/ping', function(req, res) {
  res.end(JSON.stringify({
    "runtime": "nodejs-0.12",
    "version": "0.1.1"
  }));
});

['1', '1.1'].forEach(function(apiVersion) {
  ['', '/__engine'].forEach(function(urlNamespace) {
    var route = '/' + apiVersion + '/functions';
    if (urlNamespace != '') {
      route = urlNamespace + '/' + apiVersion + '/functions';
    }

    // CORS middleware
    Cloud.use(route, function(req, res, next) {
      if (req.method.toLowerCase() === 'options') {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Max-Age','86400');
        res.setHeader('Access-Control-Allow-Methods', 'PUT, GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'X-Uluru-Application-Key, X-Uluru-Application-Id, X-Uluru-Application-Production, X-Uluru-Client-Version, X-Uluru-Session-Token, X-AVOSCloud-Application-Key, X-AVOSCloud-Application-Id, X-AVOSCloud-Application-Production, X-AVOSCloud-Client-Version, X-AVOSCloud-Session-Token, X-AVOSCloud-Super-Key, X-Requested-With, Content-Type, X-AVOSCloud-Request-sign');
        res.setHeader('Content-Length', 0);
        return res.end();
      }
      next();
    });

    Cloud.use(route, bodyParser.urlencoded({extended: false}));
    Cloud.use(route, bodyParser.json());
    Cloud.use(route, bodyParser.text());

    // domainWrapper
    Cloud.use(route, function(req, res, next) {
      if (process.domain) {
        return next();
      }
      var d = domain.create();
      d.add(req);
      d.add(res);
      d.on('error', function(err) {
        console.error('LeanEngine function uncaughtException url=%s, msg=%s', req.url, err.stack || err.message || err);
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=UTF-8');
        res.end(JSON.stringify({code: 1, error: 'LeanEndine function uncaughtException'}));
      });
      d.run(next);
    });

    // parse authInfo
    Cloud.use(route, function(req, res, next) {
      var appId, appKey, contentType, param, prod, prodHeader, prodValue, sessionToken;
      contentType = req.headers['content-type'];
      if (/^text\/plain.*/i.test(contentType)) {
        if (req.body && req.body !== '') {
          req.body = JSON.parse(req.body);
        }
        appId = req.body._ApplicationId;
        appKey = req.body._ApplicationKey;
        masterKey = req.body._MasterKey;
        prodValue = req.body._ApplicationProduction;
        sessionToken = req.body._SessionToken;
        for (param in req.body) {
          if (param.charAt(0) === '_') {
            delete req.body[param];
          }
        }
        prod = 1;
        if (prodValue === 0 || prodValue === false) {
          prod = 0;
        }
        req.AV = {
          id: appId,
          key: appKey,
          masterKey: masterKey,
          prod: prod,
          sessionToken: sessionToken
        };
      } else {
        appId = req.headers['x-avoscloud-application-id'] || req.headers['x-uluru-application-id'];
        appKey = req.headers['x-avoscloud-application-key'] || req.headers['x-uluru-application-key'];
        masterKey = req.headers['x-avoscloud-master-key'] || req.headers['x-uluru-master-key'];
        prodHeader = req.headers['x-avoscloud-application-production'] || req.headers['x-uluru-application-production'];
        sessionToken = req.headers['x-uluru-session-token'] || req.headers['x-avoscloud-session-token'];
        prod = 1;
        if (prodHeader === '0' || prodHeader === 'false') {
          prod = 0;
        }
        req.AV = {
          id: appId,
          key: appKey,
          masterKey: masterKey,
          prod: prod,
          sessionToken: sessionToken
        };
      }
      return next();
    });

    // authorization
    Cloud.use(route, function(req, res, next) {
      var key, master, requestSign, sign, timestamp, validSign, _ref;
      if (!req.AV.id) {
        return unauthResp(res);
      }
      if (AV.applicationId === req.AV.id && 
          (AV.applicationKey === req.AV.key || AV.masterKey === req.AV.key || AV.masterKey === req.AV.masterKey)) {
        if (AV.masterKey === req.AV.masterKey) {
          req.AV.authMasterKey = true;
        }
        return next();
      }
      requestSign = req.headers['x-avoscloud-request-sign'];
      if (requestSign) {
        _ref = requestSign.split(','), sign = _ref[0], timestamp = _ref[1], master = _ref[2];
        key = master === 'master' ? AV.masterKey : AV.applicationKey;
        validSign = signByKey(timestamp, key);
        if (validSign === sign.toLowerCase()) {
          if (master === 'master') {
            req.AV.authMasterKey = true;
          }
          req.AV.key = key;
          return next();
        }
      }
      return unauthResp(res);
    });

    // get metadatas func
    Cloud.use(route + '/_ops/metadatas', function(req, res, next) {
      if (req.AV.authMasterKey) {
        return resp(res, Object.keys(Cloud.__code));
      }
      return unauthResp(res);
    });

    // parseUserInfo
    Cloud.use(route, function(req, res, next) {
      if (req.AV.sessionToken && req.AV.sessionToken !== '') {
        logInBySessionToken(req.AV.sessionToken, function(err, user) {
          if (err) {
            throw err;
          }
          req.AV.user = user;
          return next();
        });
      } else if (req.body.user) {
        var userObj = new AV.User();
        userObj._finishFetch(req.body.user, true);
        req.AV.user = userObj;
        return next();
      } else {
        return next();
      }
    });

    Cloud.use(route, function(req, res) {
      if (req.url === '/') {
        return respError(res, 'no function or class name');
      }
    
      var cb = function(err, data) {
        if (err) {
          return respError(res, err);
        }
        return resp(res, data);
      };

      var meta = {
        remoteAddress: req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      };
      split = req.url.split('/');
      if (split.length == 2) { // cloud function
        call(split[1], req.body, req.AV.user, meta, function(err, data) {
          cb(err, data);
        });
      } else if (split.length == 3) { // class hook
        var userObj = new AV.User();
        if (split[1] === 'onVerified') {
          userObj._finishFetch(req.body.object, true);
          onVerified(split[2], userObj);
          cb(null, 'ok');
        } else if (split[1] === '_User' && split[2] === 'onLogin') {
          userObj._finishFetch(req.body.object, true);
          onLogin(userObj, cb);
        } else {
          classHook(split[1], hookNameMapping[split[2]], req.body.object, req.AV.user, meta, cb);
        }
      }
    });
  });
});

var createAVObject = function(className) {
  switch (className) {
    case '_User':
      return new AV.User();
    case '_Role':
      return new AV.Role();
    case '_Installation':
      return new AV.Installation();
    default:
      return new AV.Object(className);
  }
};

var resp = function(res, data) {
  res.setHeader('Content-Type', 'application/json; charset=UTF-8');
  res.statusCode = 200;
  return res.end(JSON.stringify({"result": data}));
};

var respOk = function(res) {
  resp(res, 'ok');
};

var respError = function(res, err) {
  res.setHeader('Content-Type', 'application/json; charset=UTF-8');
  res.statusCode = err.statusCode || 400;
  res.end(JSON.stringify({
    code: err.code || 1,
    error: err && (err.message || err.responseText || err) || 'null message'
  }));
};

Cloud.run = function(name, data, options) {
  try {
    Cloud.__code[name]({params: data, user: AV.User.current()}, options );
  } catch (err) {
    console.log('Run function \'' + name + '\' failed with error:', err);
    options.error(err);
  }
};

var call = function(funcName, params, user, meta, cb) {
  if (!Cloud.__code[funcName]) {
    return cb(new Error("Cloud code not find function named '" + funcName +  "' for app '" + AV.applicationId + "' on " + NODE_ENV + "."));
  }
  try {
    Cloud.__code[funcName]({
      params: params,
      user: user,
      meta: meta
    }, {
      success: function(result) {
        return cb(null, result);
      },
      error: function(err) {
        return cb(err);
      }
    });
  } catch (err) {
    console.warn('Execute \'' + funcName + '\' failed with error: ' + (err.stack || err));
    err.statusCode = 500;
    return cb(err);
  }
};

var classHook = function(className, hook, object, user, meta, cb) {
  if (!Cloud.__code[hook + className]) {
    return cb(new Error("Cloud code not find hook '" + hook + className +  "' for app '" + AV.applicationId + "' on " + NODE_ENV + "."));
  }
  var obj = createAVObject(className);
  obj._finishFetch(object, true);
  try {
    if (hook.indexOf('__after_') === 0) {
      // after 的 hook 不需要 response 参数，并且请求默认返回 ok
      Cloud.__code[hook + className]({
        user: user,
        object: obj,
        meta: meta
      });
      return cb(null, 'ok');
    } else {
      Cloud.__code[hook + className]({
        user: user,
        object: obj
      }, {
        success: function() {
          if ('__before_delete_for_' === hook) {
            return cb(null, {});
          } else {
            return cb(null, obj);
          }
        },
        error: function(err) {
          cb(new Error(err));
        }
      });
    }
  } catch (err) {
    console.warn('Execute \'' + hook + className + '\' failed with error: ' + (err.stack || err));
    if (hook.indexOf('__after__') === 0) {
      return cb(null, 'ok');
    }
    err.statusCode = 500;
    return cb(err);
  }
};

var onVerified = function(type, user) {
  try {
    Cloud.__code['__on_verified_' + type]({
      object: user
    });
  } catch (err) {
    console.warn('Execute onVerified ' + type + ' failed with error: ' + (err.stack || err));
  }
};

var onLogin = function(user, cb) {
  try {
    Cloud.__code.__on_login__User({
      object: user
    }, {
      success: function() {
        return cb(null, 'ok');
      },
      error: function(err) {
        cb(new Error(err));
      }
    });
  } catch (err) {
    console.warn('Execute onLogin failed with error: ' + (err.stack || err));
  }
};

Cloud.__code = {};

Cloud.define = function(name, func) {
  debug('define function: %s', name);
  Cloud.__code[name] = func;
};

var hookNameMapping = {
  beforeSave: '__before_save_for_',
  afterSave: '__after_save_for_',
  afterUpdate: '__after_update_for_',
  beforeDelete: '__before_save_for_',
  afterDelete: '__after_delete_for_'
};

var _define = function(className, hook, func) {
  debug('define class hook: %s %s', hook, className);
  Cloud.__code[hook + className] = func;
};

Cloud.beforeSave = function(nameOrClass, func) {
  _define(className(nameOrClass), '__before_save_for_', func);
};

Cloud.afterSave = function(nameOrClass, func) {
  _define(className(nameOrClass), '__after_save_for_', func);
};

Cloud.afterUpdate = function(nameOrClass, func) {
  _define(className(nameOrClass), '__after_update_for_', func);
};

Cloud.beforeDelete = function(nameOrClass, func) {
  _define(className(nameOrClass), '__before_delete_for_', func);
};

Cloud.afterDelete = function(nameOrClass, func) {
  _define(className(nameOrClass), '__after_delete_for_', func);
};

Cloud.onVerified = function(type, func) {
  Cloud.define('__on_verified_' + type, func);
};

Cloud.onLogin = function(func) {
  Cloud.define('__on_login__User', func);
};

var logInBySessionToken = function(sessionToken, cb) {
  var user = AV.Object._create("_User");
  user._finishFetch({ session_token: sessionToken });
  options = {
    success: function(user) {
      if (user) {
        delete user._serverData.session_token;
      }
      cb(null, user);
    },
    error: function(user, err) {
      cb(err);
    }
  };
  user.logIn(options);
};

Cloud.logInByIdAndSessionToken = function(uid, sessionToken, fetch, cb) {
  var user;
  user = new AV.User();
  user.id = uid;
  user._sessionToken = sessionToken;
  AV.User._saveCurrentUser(user);
  if (fetch) {
    return user.fetch({
      success: function(user) {
        return cb(null, user);
      },
      error: function(err) {
        return cb(err);
      }
    });
  } else {
    return cb(null, user);
  }
};

var className = function(clazz) {
  if (utils.typeOf(clazz) === 'string') {
    return clazz;
  }
  if (clazz.className)
    return clazz.className;
  throw new Error("Unknown class:" + clazz);
};

var unauthResp = function(res) {
  res.statusCode = 401;
  res.setHeader('content-type', 'application/json; charset=UTF-8');
  return res.end(JSON.stringify({ code: 401, error: "Unauthorized." }));
};

var signByKey = function(timestamp, key) {
  return crypto.createHash('md5').update("" + timestamp + key).digest("hex");
};


module.exports = AV;
