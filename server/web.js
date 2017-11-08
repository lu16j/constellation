const bodyparser = require('body-parser');
const crypto = require('crypto');
const diff = require('diff');
const enchilada = require('enchilada');
const events = require('events');
const express = require('express');
const fs = require('fs');
const moment = require('moment');
const mongodb = require('mongodb');
const pug = require('pug');
const sharedb = require('sharedb')

const logger = require('./logger');

exports.createFrontend = function createFrontend(config, db) {
  
  const log = logger.log.child({ in: 'app' });

  const join = require('./join').create(config);
  const paired = new events.EventEmitter();
  const setupproject = 'constellation-setup';
  
  const app = express();
  
  app.set('view engine', 'pug');
  app.set('views', `${__dirname}/views`);
  app.set('x-powered-by', false);
  
  app.use('/public', enchilada(`${__dirname}/public`));
  app.use('/static', express.static(`${__dirname}/static`));
  app.use(bodyparser.json());
  
  app.use(logger.express(log));
  
  app.locals.config = config;
  
  // validate parameter against anchored regex
  function validate(regex) {
    let anchored = new RegExp('^' + regex.source + '$');
    return function(req, res, next, val) {
      if (anchored.test(val)) { next(); } else { next('route'); }
    };
  }
  
  app.param('project', validate(/[\w-]+/));
  app.param('userid', validate(/\w+/));
  app.param('collabid', validate(/[0-9a-f]{24}/));
  app.param('milestone', validate(/\w+/));
  app.param('cutoff', validate(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/));
  
  function authenticate(req, res, next) {
    let cert = req.connection.getPeerCertificate();
    if ( ! req.connection.authorized) {
      return res.status(401).render('401', {
        error: req.connection.authorizationError,
        cert
      });
    }
    
    res.locals.authusername = cert.subject.emailAddress.replace('@' + config.web.certDomain, '');
    if (config.web.userFakery) {
      res.locals.authusername += '+' +
        crypto.createHash('md5').update(req.headers['user-agent']).digest('hex').substr(0, 3);
    }
    res.locals.authstaff = config.staff.indexOf(res.locals.authusername) >= 0;
    res.set('X-Authenticated-User', res.locals.authusername);
    
    res.locals.shareURL = `wss://${req.hostname}:${config.web.wss}/${db.usernameToken(res.locals.authusername)}`;
    
    next();
  }
  
  function collaboration(req, res, next) {
    db.getUser(res.locals.authusername, function(err, user) {
      res.locals.collabid = user.data && user.data.collabs.length && user.data.collabs[0];
      next();
    });
  }
  
  function staffonly(req, res, next) {
    if ( ! res.locals.authstaff) {
      return res.status(401).render('401', { error: 'Permission denied' });
    }
    next();
  }
  
  function authorize(req, res, next) {
    if (res.locals.authstaff) { return next(); }
    db.getCollab(req.params.collabid, function(err, collab) {
      if (err || collab.data.users.indexOf(res.locals.authusername) < 0) {
        return res.status(401).render('401', { error: 'Permission denied' });
      }
      next();
    });
  }
  
  app.get('/', authenticate, collaboration, function(req, res, next) {
    res.render('index');
  });
  
  app.get('/pair/:project/:id', authenticate, function(req, res, next) {
    if (req.params.project == setupproject) {
      return res.render('setup-join');
    }
    
    res.render('join', {
      project: req.params.project,
      joincode: join.code({ username: res.locals.authusername, project: req.params.project }),
    });
  });
  
  app.post('/pair/:project/:userid', authenticate, function(req, res, next) {
    let me = res.locals.authusername;
    let token = db.usernameToken(res.locals.authusername);
    
    if (req.params.project == setupproject) {
      paired.emit(req.params.userid, { me, token });
      return res.send({ redirect: '/setup-done' });
    }
    
    join.rendezvous(req.body.me, req.body.partner, function(err, agreed) {
      if (err) { return res.status(400).send({ error: err.message }); }
      
      if (res.locals.authusername == agreed.partner.username) {
        return res.status(400).send({ error: 'Cannot pair with yourself' });
      }
      if (agreed.me.project !== agreed.partner.project) {
        return res.status(400).send({ error: 'Different projects selected' });
      }
      
      let partner = agreed.partner.username;
      let project = agreed.me.project;
      let collabid = agreed.id;
      
      db.addUserToCollaboration(me, project, collabid, function(err) {
        paired.emit(req.params.userid, { me, token, partner, project, collabid });
        res.send({ redirect: '/edit' });
      });
    });
  });
  
  app.get('/setup-done', authenticate, function(req, res, next) {
    res.render('setup-done');
  });
  
  app.get('/edit', authenticate, collaboration, function(req, res, next) {
    if ( ! res.locals.collabid) {
      return res.status(400).render('400', { error: 'No current collaboration' });
    }
    res.render('files');
  });
  
  app.get('/edit/:filepath(*)', authenticate, collaboration, function(req, res, next) {
    if ( ! res.locals.collabid) {
      return res.status(400).render('400', { error: 'No current collaboration' });
    }
    res.render('edit', {
      filepath: req.params.filepath,
    });
  });
  
  app.get('/show/:project/:collabid/:cutoff', authenticate, function(req, res, next) {
    res.render('collab', {
      project: req.params.project,
      collabid: req.params.collabid,
      cutoff: req.params.cutoff,
    });
  });
  
  app.get('/show/:project/:collabid/m/:milestone', authenticate, function(req, res, next) {
    res.render('collab', {
      project: req.params.project,
      collabid: req.params.collabid,
      milestone: req.params.milestone,
    });
  });
  
  app.get('/dashboard', authenticate, staffonly, function(req, res, next) {
    db.getProjects(function(err, projects) {
      res.render('dashboard/projects', {
        projects,
      });
    });
  });
  
  app.get('/dashboard/:project/:cutoff?', authenticate, staffonly, function(req, res, next) {
    res.render('dashboard/collabs', {
      project: req.params.project,
      cutoff: req.params.cutoff,
    });
  });
  
  app.get('/dashboard/:project/checkoffs:csv(.csv)?', authenticate, staffonly, function(req, res, next) {
    db.getCheckoffs(req.params.project, function(err, milestones, users) {
      if (req.params.csv) {
        res.attachment(`constellation-checkoffs-${req.params.project}.csv`);
        res.locals.url = `https://${req.hostname}${config.web.https != 443 ? `:${config.web.https}` : ''}`;
      }
      res.render(req.params.csv ? 'dashboard/checkoffs-csv' : 'dashboard/checkoffs', {
        project: req.params.project,
        milestones,
        users,
      });
    });
  });
  
  app.get('/dashboard/:project/live/m/:milestone', authenticate, staffonly, function(req, res, next) {
    res.render('dashboard/pings', {
      project: req.params.project,
      milestone: req.params.milestone,
    });
  });
  
  app.get('/dashboard/:project/m/:milestone/:cutoff?', authenticate, staffonly, function(req, res, next) {
    res.render('dashboard/collabs', {
      project: req.params.project,
      milestone: req.params.milestone,
      cutoff: req.params.cutoff,
    });
  });
  
  app.get('/dashboard/:project/:collabid/:cutoff?', authenticate, staffonly, function(req, res, next) {
    res.render('dashboard/collab', {
      project: req.params.project,
      collabid: req.params.collabid,
      cutoff: req.params.cutoff,
    });
  });
  
  app.get('/dashboard/:project/:collabid/m/:milestone/:cutoff?', authenticate, staffonly, function(req, res, next) {
    res.render('dashboard/collab', {
      project: req.params.project,
      collabid: req.params.collabid,
      milestone: req.params.milestone,
      cutoff: req.params.cutoff,
    });
  });
  
  app.get('/baseline/:project/:filepath(*)', authenticate, staffonly, function(req, res, next) {
    db.getBaseline(req.params.project, req.params.filepath, function(err, baseline) {
      if (err) { return res.status(500).send({ code: err.code, message: err.message }); }
      res.type('text/plain');
      res.setHeader('Cache-Control', 'max-age=3600');
      res.send(baseline);
    });
  });
  
  app.get('/historical/:project/:collabid/:filepath(*)/:cutoff', authenticate, authorize, function(req, res, next) {
    db.getHistorical(req.params.collabid, req.params.filepath, moment(req.params.cutoff), function(err, historical) {
      if (err) { return res.status(500).send({ code: err.code, message: err.message }); }
      res.setHeader('Cache-Control', 'max-age=3600');
      res.send(historical);
    });
  });

  app.get('/ops/:project/:collabid/:filepath(*)', authenticate, staffonly, function(req, res, next) {
    db.getOps(req.params.collabid, req.params.filepath, function(err, ops) {
      if (err) { return res.status(500).send({ code: err.code, message: err.message }); }
      var chunkedDiffs = getChunkedDiffs(ops);
      res.setHeader('Cache-Control', 'max-age=3600');
      res.send(chunkedDiffs);
    });
  })
  
  app.get('/hello/:version', function(req, res, next) {
    getPluginVersion(function(err, version) {
      res.send({
        update: req.params.version < version ? version : undefined,
        userid: mongodb.ObjectID().toString(),
      });
    });
  });
  
  app.get('/await-collaboration/:userid', function(req, res, next) {
    let send = settings => res.send(settings);
    paired.once(req.params.userid, send);
    setTimeout(() => paired.removeListener(req.params.userid, send), 1000 * 60 * 15);
  });
  
  app.get('/install', function(req, res, next) {
    getPluginVersion(function(err, version) {
      if (err) {
        return res.status(400).render('400', { error: 'Install server not configured' });
      }
      let protocol = config.web.httpUpdateSite ? 'http' : 'https';
      let port = config.web.httpUpdateSite ? `:${config.web.httpUpdateSite}`
                                           : config.web.https != 443 ? `:${config.web.https}` : '';
      res.render('install', {
        version,
        url: `${protocol}://${req.hostname}${port}${req.path}`
      });
    });
  });
  
  app.use('/install', express.static(`${__dirname}/install`));
  
  app.createUpdateSite = function createUpdateSite() {
    const app = express();
    app.use('/install', express.static(`${__dirname}/install`));
    return app;
  };
  
  app.get('/update/:oldversion', function(req, res, next) {
    getPluginVersion(function(err, version) {
      if (err) {
        return res.status(400).render('400', { error: 'Install server not configured' });
      }
      res.render('update', {
        oldversion: req.params.oldversion.split('.', 3).join('.'),
        version,
      });
    });
  });
  
  app.get('*', function(req, res, next) {
    res.status(404).render('404');
  });
  
  return app;
};

// get the plug-in version without qualifier
function getPluginVersion(callback) {
  fs.readFile(`${__dirname}/install/version.txt`, { encoding: 'utf8' }, function(err, version) {
    callback(err, version && version.trim().split('.', 3).join('.'));
  });
}

function getChunkedDiffs(ops) {
    var chunkedDiffs = [];
    var threshold = 100000; // TODO: Tune threshold
    // 2000 -> 89 diffs
    // 10000 -> 34 diffs
    // 100000 -> 6 diffs

    /* Setup the baseline of the document */ 
    var firstOp = ops[0];

    // The baseline for the next diff
    var currentBaseline = {v:0};
    sharedb.ot.apply(currentBaseline, firstOp);
    // The doc to apply ops to
    var currentDoc = {v:0};
    sharedb.ot.apply(currentDoc, firstOp);

    var lastTs = firstOp.m.ts;

    /* Apply each op, and calculate a diff if two 
       consecutive ops are far enough apart */
    for (var i = 1; i < ops.length; i++) {
      var op = ops[i];

      // Start a new chunk if necessary
      if (op.m.ts - lastTs > threshold) {
        var chunkedDiff = diff.diffLines(
          currentBaseline.data.text.trim(), currentDoc.data.text.trim());
        
        // Only push diffs with changes
        if (!(chunkedDiff.length == 1 && 
            !chunkedDiff[0].added &&
            !chunkedDiff[0].removed)) {
          chunkedDiffs.push(chunkedDiff);
        }

        // Make a deep copy
        currentBaseline = JSON.parse(JSON.stringify(currentDoc));
        
      }

      // Apply the op
      let err = sharedb.ot.apply(currentDoc, op);
      if (err) {
        // TODO: Better error handling
        console.log("err when applying op:" + JSON.stringify(err));
        return;
      }
         
      lastTs = op.m.ts;
    }

    return chunkedDiffs; 
}

// Merges multiple diffs into one diff with all
// additions and deletes kept.

// TODO: This seems much too complicated
function mergeDiffs(diffs) {
  mergedDiff = diffs[0];
  for (int i = 1; i < diffs.length; i++) {
    var diff = diffs[i];

    // Store what index we're currently on in each file
    var currentChunkInMerged = 0;
    var indexInCurrentChunkInMerged = 0;
    var indexInText = 0;
    diff.forEach(function(part) {
      if (part.added) {
        // Add this part 
        // TODO: Might have to split up a part of the merged diff

        var currentChunk = mergedDiff[currentChunkInMerged];


      } else if (part.removed) {

      } else {
        var totalIndexInMerged = indexInText;

        // It's the same as before, so just increment the counter
        indexInText += part.value.length;

        // Find the next chunk in the currently merged part
        // Anything that's added or the same is valid
        while (totalIndexInMerged < indexInText) {
          var currentChunk = mergedDiff[currentChunkInMerged];
          if (indexInCurrentChunkInMerged < currentChunk.value.length) {
            // Haven't gotten to the end of the chunk yet
            indexInCurrentChunkInMerged += 1;
          } else {
            // We've gone over the end of a chunk, so find the next chunk
            // The only valid next chunks are normals or added, 
            // but not removed since those weren't starting characters
            // for the next diff
            currentChunkInMerged += 1;
            var nextChunk = mergedDiff[currentChunkInMerged];
            while (nextChunk.removed) {
              currentChunkInMerged += 1;
              nextChunk = mergedDiff[currentChunkInMerged];
            }

            // It's a new chunk, so reset this index
            indexInCurrentChunkInMerged = 0;
          }

          totalIndexInMerged += 1;
        }
      }
    });
  }
}