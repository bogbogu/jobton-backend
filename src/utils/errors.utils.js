// Turns Mongoose validation/cast failures into something safe to show a client.
//
// Mongoose's own messages and error objects leak internals: the model name
// ("Job validation failed: ..."), the offending value, schema paths and, for
// enum failures, the stored value ("`x` is not a valid enum value for path
// `employmentType`."). Nothing from them is forwarded except:
//   - the field path (it is the same name the client sent in its request), and
//   - messages WE authored on a validator ("{PATH} must be an http(s) URL.").
// Everything else is rebuilt from the error `kind` plus schema limits
// (min/max/length/enum list), never from the submitted value.

const MAX_FIELD_ERRORS = 20;
const SAFE_PATH = /^[A-Za-z0-9_.]{1,100}$/;

const safePath = (path) => (typeof path === "string" && SAFE_PATH.test(path) ? path : "value");

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

// Mongoose's built-in "required" text ("Path `x` is required.") is replaced; a
// message passed to `required: [true, "Job title is required"]` is ours.
const isDefaultRequiredMessage = (message, path) => message === `Path \`${path}\` is required.`;

const friendlyMessage = (detail, path) => {
  const properties = detail?.properties || {};

  // A CastError: the value could not be converted to the field's type.
  if (detail?.name === "CastError") {
    return `${path} has an invalid value.`;
  }

  switch (detail?.kind) {
    case "required":
      return typeof detail.message === "string" && !isDefaultRequiredMessage(detail.message, path)
        ? detail.message
        : `${path} is required.`;

    case "enum":
      return Array.isArray(properties.enumValues) &&
        properties.enumValues.length > 0 &&
        properties.enumValues.every((value) => typeof value === "string")
        ? `${path} must be one of: ${properties.enumValues.join(", ")}.`
        : `${path} has an invalid value.`;

    case "minlength":
      return isFiniteNumber(properties.minlength)
        ? `${path} must be at least ${properties.minlength} characters.`
        : `${path} is too short.`;

    case "maxlength":
      return isFiniteNumber(properties.maxlength)
        ? `${path} must be at most ${properties.maxlength} characters.`
        : `${path} is too long.`;

    case "min":
      return isFiniteNumber(properties.min)
        ? `${path} must be at least ${properties.min}.`
        : `${path} is too small.`;

    case "max":
      return isFiniteNumber(properties.max)
        ? `${path} must be at most ${properties.max}.`
        : `${path} is too large.`;

    case "user defined":
      // Authored validator message. If the validator itself threw, Mongoose
      // puts the thrown Error's text there instead: do not forward that.
      return typeof detail.message === "string" && !properties.reason
        ? detail.message
        : `${path} is invalid.`;

    default:
      return `${path} is invalid.`;
  }
};

export const isValidationError = (error) => error?.name === "ValidationError";

export const isCastError = (error) => error?.name === "CastError";

export const isDuplicateKeyError = (error) => error?.code === 11000;

// { field: friendlyMessage } for a Mongoose ValidationError (or a lone CastError).
export const toFieldErrors = (error) => {
  const fields = {};

  if (isCastError(error)) {
    const path = safePath(error.path);
    fields[path] = friendlyMessage(error, path);
    return fields;
  }

  for (const [rawPath, detail] of Object.entries(error?.errors || {})) {
    if (Object.keys(fields).length >= MAX_FIELD_ERRORS) break;

    const path = safePath(rawPath);
    fields[path] = friendlyMessage(detail, path);
  }

  return fields;
};

// Body for a 400. `message` stays a readable sentence (the frontend shows it
// as-is); `error` and `fields` let it branch or highlight inputs.
export const validationErrorBody = (error) => {
  const fields = toFieldErrors(error);
  const details = Object.values(fields).join(" ");

  return {
    message: details ? `Validation failed. ${details}` : "Validation failed.",
    error: "VALIDATION_ERROR",
    fields,
  };
};

// True for the errors a client can cause by sending a bad body.
export const isInputError = (error) => isValidationError(error) || isCastError(error);
