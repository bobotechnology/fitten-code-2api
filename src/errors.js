function createHttpError(statusCode, message, metadata = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.type = metadata.type;
  error.code = metadata.code;
  error.param = metadata.param;
  return error;
}

function normalizeError(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  return {
    statusCode,
    message: error?.message || 'unexpected error',
    type: error?.type || (statusCode >= 500 ? 'server_error' : 'invalid_request_error'),
    code: error?.code || (statusCode >= 500 ? 'internal_error' : 'invalid_request'),
    param: error?.param || null
  };
}

module.exports = {
  createHttpError,
  normalizeError
};
