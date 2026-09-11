import { NextResponse, type NextRequest } from "next/server"

// To support Optimizely CMS 12 Edit URLs, wrap your middleware with the
// `withEditFallback` wrapper show here.
// import { withEditFallback } from '@remkoj/optimizely-cms-nextjs/preview'

type SecurityHeader = { key: string; value: string; isRemoval: boolean; isReplacement: boolean }
type SecurityHeadersResponse = { headers: SecurityHeader[]; publishedAt: string; cacheSeconds: number }

const headerEndpoint = "https://function.zaius.app/stott_security/compiled_headers/712eff36-ac9e-43cd-91e4-a494ba41b5e5";
const defaultCacheSeconds = 300;
const errorBackoffSeconds = 30;

// Module scoped cache of the compiled headers. Next.js ignores fetch cache
// options in middleware, and this avoids an upstream call on every request.
// The cache lives per edge isolate, so it is best effort rather than shared.
let cachedHeaders: SecurityHeader[] = [];
let cacheExpiresAt = 0;

async function getSecurityHeaders(pathname: string): Promise<SecurityHeader[]>
{
    if (Date.now() < cacheExpiresAt)
        return cachedHeaders;

    try
    {
        const cmsResponse = await fetch(headerEndpoint, {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(2000)
        });
        if (!cmsResponse.ok)
            throw new Error(`Unexpected status ${cmsResponse.status}`);

        const data: SecurityHeadersResponse = await cmsResponse.json();

        const cachedAt = new Date().toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC';
        cachedHeaders = [
            ...(Array.isArray(data.headers) ? data.headers : []),
            { key: 'cached-at', value: cachedAt, isRemoval: false, isReplacement: true }
        ];
        cacheExpiresAt = Date.now() + (data.cacheSeconds ?? defaultCacheSeconds) * 1000;
    }
    catch (error)
    {
        // Replace with your logger
        console.error({
            error,
            url: headerEndpoint,
            path: pathname,
            context: "middleware - security headers processing error"
        });
        // Keep serving the last known headers and retry after a short back off
        cacheExpiresAt = Date.now() + errorBackoffSeconds * 1000;
    }

    return cachedHeaders;
}

const noncePlaceholder = "'nonce-random'";
const cspHeaderNames = ['content-security-policy', 'content-security-policy-report-only'];

function isCspHeader(key: string): boolean
{
    return cspHeaderNames.includes(key.toLowerCase());
}

function generateNonce(): string
{
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
}

function applySecurityHeaders(headers: Headers, securityHeaders: SecurityHeader[], nonce: string)
{
    securityHeaders.forEach(h => {
        const value = isCspHeader(h.key) ? h.value.replaceAll(noncePlaceholder, `'nonce-${nonce}'`) : h.value;
        if (h.isRemoval)
            headers.delete(h.key);
        else if (h.isReplacement)
            headers.set(h.key, value);
        else
            headers.append(h.key, value);
    });
}

/**
 * Site middleware, which applies the security headers published by the
 * headerEndpoint to every matched response, substituting a per request
 * nonce into the Content Security Policy headers.
 *
 * The nonce and the CSP headers are also forwarded on the request, so that
 * Next.js applies the nonce to its own script and style tags when rendering
 * dynamically, and so components can read it using headers().get('x-nonce').
 */
export async function middleware(request: NextRequest)
{
    const nonce = generateNonce()
    const securityHeaders = await getSecurityHeaders(request.nextUrl.pathname)

    const requestHeaders = new Headers(request.headers)
    requestHeaders.set('x-nonce', nonce)
    applySecurityHeaders(requestHeaders, securityHeaders.filter(h => isCspHeader(h.key)), nonce)

    const response = NextResponse.next({
        request: {
            headers: requestHeaders
        }
    })
    applySecurityHeaders(response.headers, securityHeaders, nonce)
    return response
}

export const config = {
    matcher: [
      // Skip all internal paths and paths with a '.'
      '/((?!.*\.|api|assets|preview|_next\/static|_next\/image|_vercel).*)',
    ]
}
