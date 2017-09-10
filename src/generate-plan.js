'use strict';

var Action = require('./models/action');
var github = require('./github');
var getReviewers = require('./get-reviewers');
var url = require('./url');

module.exports = function generatePlan (options) {
  options = options || {};
  var actions = [];
  var config = process.env.PULL_REVIEW_CONFIG || options.config;
  var pullReviewConfigPath = process.env.PULL_REVIEW_CONFIG_PATH || options.pullReviewConfigPath || '.pull-review';
  var pullRequestURL = options.pullRequestURL;
  var retryReview = Boolean(options.retryReview);
  var dryRun = Boolean(options.dryRun);
  var isChat = Boolean(options.isChat);
  var room = options.room;
  var adapter = options.adapter;
  var text = options.text;
  var pullRequestRecord;
  var pullRequestFiles;
  var pullRequestAssignees;
  var newPullRequestAssignees;
  var repoPullReviewConfig;

  if (isChat) {
    if (!room || !text) {
      throw Error('Missing chat data');
    }

    var urls = url.extractURLs(text);
    var processedText = text.replace(/\s+/g, ' ').replace(/(\breview | again\b)/ig, function (m) { return m.toLowerCase(); });

    if (Array.isArray(urls)) {
      for (var i = 0; i < urls.length; i++) {
        var u = urls[i];
        var uo = url.parseURL(u);

        if (uo.hostname === 'github.com') {
          var reviewIndex = processedText.indexOf('review ' + u);
          if (reviewIndex !== -1) {
            retryReview = processedText.indexOf('review ' + u + ' again') === reviewIndex;
            pullRequestURL = u;
            break;
          }
        }
      }
    }
  }

  if (!pullRequestURL) {
    if (isChat) {
      return;
    } else {
      throw Error('Missing pull request URL');
    }
  }

  var pullRequest = github.parseGithubURL(pullRequestURL);

  if (!pullRequest) {
    throw Error('Invalid pull request URL');
  }

  //todo: validate chat room

  return github.getPullRequest(pullRequest)
    .catch(function (e) {
      throw Error('Failed to get pull request: ' + pullRequestURL);
    })
    .then(function (res) {
      var unassignAssignees;
      pullRequestRecord = res;

      if (pullRequestRecord.data.state !== 'open') {
        throw Error('Pull request is not open: ' + pullRequestURL);
      }

      if (pullRequestRecord.data.assignees) {
        pullRequestAssignees = pullRequestRecord.data.assignees;
      } else if (pullRequestRecord.data.assignee) {
        pullRequestAssignees = [pullRequestRecord.data.assignee];
      }

      if (pullRequestAssignees && pullRequestAssignees.length) {
        pullRequestAssignees = pullRequestAssignees.map(function (assignee) {
          return assignee.login;
        });

        if (retryReview) {
          actions.push(Action({
            'type': 'UNASSIGN_USERS_FROM_PULL_REQUEST',
            'payload': {
              'pullRequest': pullRequest,
              'assignees': pullRequestAssignees
            }
          }));
        }
      }

      return Promise.all([
        github.getPullRequestFiles(pullRequest),
        config ? null : github.getRepoFile(pullRequest, pullReviewConfigPath, 'utf8')
          .catch(function () { return null; }),
        unassignAssignees
      ]);
    })
    .then(function (res) {
      pullRequestFiles = res[0];
      repoPullReviewConfig = res[1];
      config = config || repoPullReviewConfig;

      if (!config) {
        throw Error('Missing configuration');
      }

      return getReviewers({
        'config': config,
        'files': pullRequestFiles,
        'authorLogin': pullRequestRecord.data.user.login,
        'assignees': retryReview ? [] : pullRequestAssignees,
        'getBlameForFile': function (file) {
          return github.getBlameForCommitFile({
            'owner': pullRequest.owner,
            'repo': pullRequest.repo,
            'sha': pullRequestRecord.data.head.sha,
            'path': file.filename
          });
        }
      });
    })
    .then(function (reviewers) {
      if (!reviewers || !reviewers.length) {
        throw Error('No reviewers found: ' + pullRequestURL);
      }

      newPullRequestAssignees = reviewers.map(function (reviewer) {
        return reviewer.login;
      });

      var channels = ['github'];

      if (isChat) {
        channels.push(adapter === 'hubot:slack' ? 'hubot:slack' : 'hubot:generic');
      }

      actions.push(Action({
        'type': 'ASSIGN_USERS_TO_PULL_REQUEST',
        'payload': {
          'pullRequest': pullRequest,
          'assignees': newPullRequestAssignees,
          'reviewers': reviewers
        }
      }));

      actions.push(Action({
        'type': 'NOTIFY',
        'payload': {
          'pullRequest': pullRequest,
          'users': newPullRequestAssignees,
          'channels': channels
        }
      }));

      if (!dryRun) {
        actions.push(Action({
          'type': 'COMMIT',
          'payload': true
        }));
      }

      return actions;
    });
};
