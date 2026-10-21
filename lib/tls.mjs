// TLS-verification bypasses. A proxy that re-signs traffic (corporate MITM,
// Zscaler, a VPN) makes every fetch fail with a certificate error, and the
// agent's fastest way past one is to switch verification off — for one command
// or, worse, in committed code and config. The fix is always the same: trust
// the proxy's CA instead of trusting everything. One table, read by the command
// sentinel (what the agent runs) and the hazard scan (what lands in a file).
// Suppress a reviewed line with: # omit-allow: <reason>

// Character classes like [E] and [d] below are not decoration: spelled
// literally, those patterns match their own source and this file flags itself.
const TLS_RULES = [
  ['node-tls-reject-unauthorized', /NODE_TLS_REJECT_UNAUTHORIZED['"\]]*\s*[=:]\s*['"]?0(?!\d)/],
  ['reject-unauthorized-false', /rejectUnauthorized['"]?\s*[:=]\s*false\b/],
  ['verify-false', /\bverify\s*=\s*False\b|\bcheck_hostname\s*=\s*False\b/],
  ['ssl-unverified-context', /\bssl\._create_unverified_context\b/],
  ['ssl-cert-none', /\bCERT_NON[E]\b/],
  ['insecure-skip-verify', /\bInsecureSkipVerify\s*[:=]+\s*true\b/],
  ['curlopt-ssl-verify-off', /CURLOPT_SSL_VERIFY(?:PEER|HOST)\s*,\s*(?:false|0)\b/i],
  ['curl-insecure', /\bcurl\b[^|;&\n]*\s(?:-[a-zA-Z]*k[a-zA-Z]*|--(?:proxy-)?insecure)(?=\s|$)/],
  ['wget-no-check-certificate', /\bwget\b[^|;&\n]*\s--no-check-cert\w*/],
  ['strict-ssl-off', /strict[-_]?ssl['"]?(?:\s*[:=]\s*|\s+)['"]?false\b/i],
  ['git-ssl-verify-off', /\bhttp\.sslVerify['"]?(?:\s+|\s*=\s*)['"]?(?:false|0|off|no)\b|^[ \t]*sslVerify[ \t]*=\s*(?:false|0|off|no)\b|\bGIT_SSL_NO_VERIFY\s*=\s*['"]?[^\s'"0]/im],
  ['pip-trusted-host', /--truste[d]-host\b|^[ \t]*trusted-host[ \t]*=/m],
  ['aws-no-verify-ssl', /\baws\b[^|;&\n]*\s--no-verify-ssl\b/],
  ['python-https-verify-off', /\bPYTHONHTTPSVERIFY\s*=\s*['"]?0\b/],
]

export const TLS_FIX =
  'Certificate errors behind a proxy are fixed by trusting its CA, not by trusting everything:\n' +
  '  Node      NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem\n' +
  '  npm       npm config set cafile /path/to/corp-ca.pem\n' +
  '  Python    REQUESTS_CA_BUNDLE / SSL_CERT_FILE=/path/to/corp-ca.pem, pip --cert /path/to/corp-ca.pem\n' +
  '  git       git config http.sslCAInfo /path/to/corp-ca.pem\n' +
  '  curl      curl --cacert /path/to/corp-ca.pem\n' +
  'Ask the user for the CA bundle if none is on the machine.'

export const findTls = (text) => TLS_RULES.filter(([, re]) => re.test(text)).map(([rule]) => rule)
