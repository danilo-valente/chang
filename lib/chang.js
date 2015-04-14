'use strict';

// Export chang
module.exports = chang;

// TODO: pre-commit hook for validating messages
// TODO: report errors, currently Q silence everything which really sucks

var child = require('child_process');
var fs = require('fs');
var util = require('util');
var cli = require('cli');
var qq = require('qq');
var i18n = require('i18n');
var __ = i18n.__;
var _ = require('lodash');

var GIT_LOG_CMD = 'git log --grep="%s" -E --format=%s %s..HEAD';
var GIT_TAG_NAME_CMD = 'git tag -l %s';
var GIT_TAG_CMD = 'git describe --tags --abbrev=0';

var HEADER_TPL = '<a name="%s"></a>\n# %s (%s)\n\n';

// TODO: parameterized issues/commits links
var LINK_ISSUE = '[#%s](https://github.com/%s/issues/%s)';
var LINK_COMMIT = '[%s](https://github.com/%s/commit/%s)';

var EMPTY_COMPONENT = '$$';

i18n.configure({
    locales: ['en_US'],
    defaultLocale: 'en_US',
    directory: __dirname + '/locales'
});

// Functions
function chang(options) {
    options = _.extend({}, require('./defaults.js'), options);

    if (!options.release) cli.info('Missing release version');
    if (!options.github_repo) cli.info('Missing Github repository');
    cli.ok('Language chosen: ' + options.language);

    if (options.tag) {
        return getTag(options.tag).then(cb);
    } else {
        return getPreviousTag().then(cb);
    }

    // Functions
    function cb(tag) {
        return parseGitLog(tag, options.github_repo, options.release, options.output, log, warn);
    }

    function log() {
        cli.ok.apply(cli, arguments);
    }

    function warn() {
        cli.info.apply(cli, arguments);
    }
}

function parseGitLog(tag, githubRepo, release, file, log, warn) {
    log('Reading git log since ' + tag);
    return readGitLog('^fix|^feat|^perf|BREAKING', tag, warn).then(function (commits) {
        log('Parsed ' + commits.length + ' commits');
        log('Generating changelog to ' + (file || 'stdout'));
        var output = file ? fs.createWriteStream(file) : process.stdout;
        writeChangelog(output, githubRepo, commits, release);
    });
}

function getTag(tag) {
    var deferred = qq.defer();
    child.exec(util.format(GIT_TAG_NAME_CMD, tag), function (code, stdout, stderr) {
        if (code || !stdout) {
            deferred.reject('Cannot find tag ' + tag);
        } else {
            deferred.resolve(stdout.replace('\n', ''));
        }
    });
    return deferred.promise;
}

function getPreviousTag() {
    var deferred = qq.defer();
    child.exec(GIT_TAG_CMD, function (code, stdout, stderr) {
        if (code) {
            deferred.reject('Cannot get the previous tag.');
        } else {
            deferred.resolve(stdout.replace('\n', ''));
        }
    });
    return deferred.promise;
}

function writeChangelog(stream, githubRepo, commits, release) {
    release = release || '';
    
    var sections = {
        fix: {},
        feat: {},
        perf: {},
        breaks: {}
    };

    sections.breaks[EMPTY_COMPONENT] = [];

    commits.forEach(function (commit) {
        var section = sections[commit.type];
        var component = commit.component || EMPTY_COMPONENT;

        if (section) {
            section[component] = section[component] || [];
            section[component].push(commit);
        }

        if (commit.breaking) {
            sections.breaks[component] = sections.breaks[component] || [];
            sections.breaks[component].push({
                subject: __('due to %s,\n %s', linkToCommit(commit.hash, githubRepo), commit.breaking),
                hash: commit.hash,
                closes: []
            });
        }
    });

    stream.write(util.format(HEADER_TPL, release, release, currentDate()));
    printSection(stream, githubRepo, __('Bug Fixes'), sections.fix);
    printSection(stream, githubRepo, __('Features'), sections.feat);
    printSection(stream, githubRepo, __('Performance Improvements'), sections.perf);
    printSection(stream, githubRepo, __('Breaking Changes'), sections.breaks, false);
}

function readGitLog(grep, from, warn) {
    var deferred = qq.defer();

    // TODO(vojta): if it's slow, use spawn and stream it instead
    child.exec(util.format(GIT_LOG_CMD, grep, '%H%n%s%n%b%n==END==', from), function (code, stdout, stderr) {
        var commits = [];

        stdout.split('\n==END==\n').forEach(function (rawCommit) {
            var commit = parseRawCommit(rawCommit, warn);
            if (commit) {
                commits.push(commit);
            }
        });

        deferred.resolve(commits);
    });

    return deferred.promise;
}

function printSection(stream, githubRepo, title, section, printCommitLinks) {
    printCommitLinks = printCommitLinks === undefined ? true : printCommitLinks;
    var components = Object.getOwnPropertyNames(section).sort();

    if (!components.length) return;

    stream.write(util.format('\n## %s\n\n', title));

    components.forEach(function (name) {
        var prefix = '-';
        var nested = section[name].length > 1;

        if (name !== EMPTY_COMPONENT) {
            if (nested) {
                stream.write(util.format('- **%s:**\n', name));
                prefix = '  -';
            } else {
                prefix = util.format('- **%s:**', name);
            }
        }

        section[name].forEach(function (commit) {
            if (printCommitLinks) {
                stream.write(util.format('%s %s\n  (%s', prefix, commit.subject, linkToCommit(commit.hash, githubRepo)));
                if (commit.closes.length) {
                    stream.write(',\n   ' + commit.closes.map(function (issue) {
                        return linkToIssue(issue, githubRepo);
                    }).join(', '));
                }
                stream.write(')\n');
            } else {
                stream.write(util.format('%s %s\n', prefix, commit.subject));
            }
        });
    });

    stream.write('\n');
}

function currentDate() {
    var now = new Date();
    var pad = function (i) {
        return ('0' + i).substr(-2);
    };

    return __('%d-%s-%s', now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()));
}

function linkToCommit(hash, githubRepo) {
    if (githubRepo) {
        return util.format(LINK_COMMIT, hash.substr(0, 8), githubRepo, hash);
    }
    return hash;
}

function linkToIssue(issue, githubRepo) {
    if (githubRepo) {
        return util.format(LINK_ISSUE, issue, githubRepo, issue);
    }
    return issue;
}

function parseRawCommit(raw, warn) {
    if (!raw) return null;

    var lines = raw.split('\n');
    var msg = {}, match;

    msg.hash = lines.shift();
    msg.subject = lines.shift();
    msg.closes = [];
    msg.breaks = [];

    lines.forEach(function (line) {
        match = line.match(/(?:Closes|Fixes)\s#(\d+)/);
        if (match) msg.closes.push(parseInt(match[1]));
    });

    match = raw.match(/BREAKING CHANGE:([\s\S]*)/);
    if (match) {
        msg.breaking = match[1];
    }


    msg.body = lines.join('\n');
    match = msg.subject.match(/^(.*)\((.*)\)\:\s(.*)$/);

    if (!match || !match[1] || !match[3]) {
        cli.info('Incorrect message: ' + msg.hash + ' ' + msg.subject);
        return null;
    }

    msg.type = match[1];
    msg.component = match[2];
    msg.subject = match[3];

    return msg;
}