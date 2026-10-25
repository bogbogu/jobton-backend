// Last two middlewares in app.js.
//
// Nothing from an unexpected error reaches the client: no stack, no err.message,
// no Mongoose/driver details, in any NODE_ENV. The only errors that get a
// specific answer are the request-body parser's, because the client caused
// them and the answer is a fixed string.

export const notFoundHandler = (req, res) =>
  res.status(404).json({
    message: "Not found.",
    error: "NOT_FOUND",
  });

// body-parser error `type` -> fixed client response.
const BODY_PARSER_RESPONSES = {
  "entity.parse.failed": { status: 400, message: "Invalid JSON.", error: "INVALID_JSON" },
  "entity.verify.failed": { status: 400, message: "Invalid request body.", error: "INVALID_BODY" },
  "request.aborted": { status: 400, message: "Request was aborted.", error: "INVALID_BODY" },
  "request.size.invalid": { status: 400, message: "Invalid request body.", error: "INVALID_BODY" },
  "entity.too.large": { status: 413, message: "Request body is too large.", error: "PAYLOAD_TOO_LARGE" },
  "parameters.too.many": { status: 413, message: "Request body is too large.", error: "PAYLOAD_TOO_LARGE" },
  "encoding.unsupported": {
    status: 415,
    message: "Unsupported content encoding.",
    error: "UNSUPPORTED_MEDIA_TYPE",
  },
  "charset.unsupported": {
    status: 415,
    message: "Unsupported charset.",
    error: "UNSUPPORTED_MEDIA_TYPE",
  },
};

// Any other error the request pipeline marks as the client's fault (for example a
// corrupt gzip body, or a charset the body parser cannot decode). Only the status
// is used; the text is fixed, never err.message.
const CLIENT_ERROR_MESSAGES = {
  400: { message: "Bad request.", error: "BAD_REQUEST" },
  413: { message: "Request body is too large.", error: "PAYLOAD_TOO_LARGE" },
  415: { message: "Unsupported media type.", error: "UNSUPPORTED_MEDIA_TYPE" },
};

const clientErrorStatus = (err) => {
  const status = err?.status ?? err?.statusCode;
  return err?.expose === true && Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
};

// Express requires all four parameters to treat this as an error handler.
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  // The response is already partly sent: only Express can close it safely.
  if (res.headersSent) {
    return next(err);
  }

  const known = typeof err?.type === "string" ? BODY_PARSER_RESPONSES[err.type] : undefined;

  if (known) {
    // Not console.error(err): a body-parser error carries the raw request body.
    console.warn(`Rejected request body: ${err.type} (${known.status})`);

    return res.status(known.status).json({ message: known.message, error: known.error });
  }

  const clientStatus = clientErrorStatus(err);

  if (clientStatus) {
    const response = CLIENT_ERROR_MESSAGES[clientStatus] || CLIENT_ERROR_MESSAGES[400];

    console.warn(`Rejected request: ${clientStatus}`);

    return res.status(CLIENT_ERROR_MESSAGES[clientStatus] ? clientStatus : 400).json(response);
  }

  console.error(err);

  return res.status(500).json({ message: "Internal server error." });
};
