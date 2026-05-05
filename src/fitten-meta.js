const crypto = require('crypto');
const path = require('path');

function getWorkspacePath() {
  return process.cwd();
}

function getProjectName(workspacePath = getWorkspacePath()) {
  return path.basename(workspacePath) || 'unknown';
}

function getProjectId(workspacePath = getWorkspacePath()) {
  return crypto
    .createHash('md5')
    .update(workspacePath)
    .digest('hex');
}

function getSessionId() {
  return crypto.randomUUID();
}

function buildFittenMeta(options = {}) {
  const workspacePath = options.workspacePath || getWorkspacePath();
  const projectName = options.projectName || getProjectName(workspacePath);
  const projectId = options.projectId || getProjectId(workspacePath);
  const sessionId = options.sessionId || getSessionId();

  return {
    project_id: projectId,
    project_name: projectName,
    session_id: sessionId,
    workspace_path: workspacePath
  };
}

module.exports = {
  buildFittenMeta,
  getWorkspacePath,
  getProjectName,
  getProjectId,
  getSessionId
};
