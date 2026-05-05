const { buildFittenMeta } = require('./fitten-meta');

function buildFittenChatPayload(messages, session, options = {}) {
  return {
    inputs: options.inputs,
    ft_token: session.userId,
    meta_datas: buildFittenMeta(options.meta)
  };
}

module.exports = {
  buildFittenChatPayload
};
