const crypto = require("crypto");
const path = require("path");

module.exports = function ({
  reportUri,
  reportPercentage,
  reportOnly = false,
  exclude = [],
  viewDirectives = {},
}) {
  const header = reportOnly
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

  const defaultPolicy = buildDefaultPolicy(reportUri);

  return function (req, res, next) {
    // set the default policy
    res.set(header, defaultPolicy);

    const originalRender = res.render;

    res.render = (...args) => {
      const view = relativeViewPath(args[0]);

      if (exclude.includes(view)) {
        // remove the default policy
        res.removeHeader(header);
      } else {
        // set the view policy
        res.locals.cspEnabled = true;

        const scriptNonce = crypto.randomBytes(16).toString("base64");

        res.locals.scriptNonce = scriptNonce;

        const policy = buildViewPolicy(
          scriptNonce,
          reportPercentage,
          reportUri,
          viewDirectives[view]
        );

        // Note: https://csp-evaluator.withgoogle.com/ is useful for checking the policy

        res.set(header, policy);
      }

      originalRender.apply(res, args);
    };

    next();
  };
};

const buildDefaultPolicy = (reportUri, styleSrc) => {
  const directives = [
    `base-uri 'none'`, // forbid setting a "base" element
    `default-src 'none'`, // forbid loading anything from a "src" attribute
    `form-action 'none'`, // forbid setting a form action
    `frame-ancestors 'none'`, // forbid loading embedded content
    `img-src 'self'`, // allow loading images from the same domain (e.g. the favicon).
  ];

  if (reportUri) {
    directives.push(`report-uri ${reportUri}`);
    // NOTE: implement report-to once it's more widely supported
  }

  if (styleSrc) {
    directives.push(`style-src ${styleSrc}`);
  }

  return directives.join("; ");
};

const buildViewPolicy = (
  scriptNonce,
  reportPercentage,
  reportUri,
  viewDirectives
) => {
  let scriptSrc = "";
  if (process.env.PLAUSIBLE_SCRIPT_URL) {
    scriptSrc = `${process.env.PLAUSIBLE_SCRIPT_URL} 'nonce-${scriptNonce}' 'unsafe-inline'`;
  } else {
    scriptSrc = `'nonce-${scriptNonce}' 'unsafe-inline' 'strict-dynamic' https: 'report-sample'`;
  }

  const directives = [
    `script-src ${scriptSrc}`, // only allow scripts from certain sources
    `object-src 'none'`, // forbid loading an "object" element
    `base-uri 'none'`, // forbid setting a "base" element
    ...(viewDirectives ?? []),
  ];

  if (reportUri) {
    // enable the report URI for a percentage of CSP-enabled requests
    const belowReportCutoff = Math.random() * 100 <= reportPercentage;

    if (belowReportCutoff) {
      directives.push(`report-uri ${reportUri}`);
      // NOTE: implement report-to once it's more widely supported
    }
  }

  return directives.join("; ");
};

const webRoot = path.resolve(__dirname, "..", "..", "..");

// build the view path relative to the web root
function relativeViewPath(view) {
  return path.isAbsolute(view)
    ? path.relative(webRoot, view)
    : path.join("app", "views", view);
}

function removeCSPHeaders(res) {
  res.removeHeader("Content-Security-Policy");
  res.removeHeader("Content-Security-Policy-Report-Only");
}

/**
 * WARNING: allowing inline styles can open a security hole;
 * this is intended only for use in specific circumstances, such as Safari's built-in PDF viewer.
 */
function allowUnsafeInlineStyles(res) {
  res.set(
    "Content-Security-Policy",
    buildDefaultPolicy(undefined, "'unsafe-inline'")
  );
}

module.exports.buildDefaultPolicy = buildDefaultPolicy;
module.exports.removeCSPHeaders = removeCSPHeaders;
module.exports.allowUnsafeInlineStyles = allowUnsafeInlineStyles;
