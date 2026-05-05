const crypto = require('crypto');
const path = require('path');

function getProjectId(workspacePath) {
  return crypto.createHash('md5').update(workspacePath).digest('hex');
}

function buildFittenMeta(options = {}) {
  const workspacePath = options.workspacePath || process.cwd();
  return {
    project_id: options.projectId || getProjectId(workspacePath),
    project_name: options.projectName || path.basename(workspacePath) || 'unknown',
    session_id: options.sessionId || crypto.randomUUID(),
    workspace_path: workspacePath
  };
}

function buildFittenChatPayload(session, options = {}) {
  return {
    inputs: options.inputs,
    ft_token: session.userId,
    meta_datas: buildFittenMeta(options.meta)
  };
}

module.exports = {
  buildFittenChatPayload
};
