import { NextResponse, type NextRequest } from "next/server";

// To support Optimizely CMS 12 Edit URLs, wrap your middleware with the
// `withEditFallback` wrapper show here.
// import { withEditFallback } from '@remkoj/optimizely-cms-nextjs/preview'

type SecurityHeader = { key: string; value: string; isRemoval: boolean; isReplacement: boolean };
type SecurityHeadersResponse = { headers: SecurityHeader[]; publishedAt: string; cacheSeconds: number };

// Endpoint publishing the compiled security headers, and how long to keep them
const headerEndpoint = "https://function.zaius.app/stott_security/compiled_headers/712eff36-ac9e-43cd-91e4-a494ba41b5e5";
const headerFetchTimeoutMs = 2000;
const defaultCacheSeconds = 300;
const errorBackoffSeconds = 30;

// Content Security Policy nonce handling
const noncePlaceholder = "'nonce-random'";
const cspHeaderNames = ['content-security-policy', 'content-security-policy-report-only'];

// Marks the inner page fetch made by this middleware, so it is not processed twice
const passthroughHeader = 'x-csp-passthrough';

/**
 * Site middleware, which applies the security headers published by the
 * headerEndpoint to every matched response, substituting a per request
 * nonce into the Content Security Policy headers.
 *
 * Statically generated pages are rendered once and cached, so Next.js cannot
 * put a per request nonce into their HTML. For HTML page requests this
 * middleware therefore fetches the page itself, which is served from the
 * cache for static routes, and injects the nonce into every script and style
 * tag as the HTML streams back. The inner fetch carries a passthrough header
 * which the matcher excludes, so it does not invoke this middleware again.
 */
export async function middleware(request: NextRequest)
{
    // Safety net should the matcher exclusion ever fail, to avoid a fetch loop
    if (request.headers.has(passthroughHeader))
        return NextResponse.next();

    const nonce = generateNonce();
    const securityHeaders = await getSecurityHeaders(request.nextUrl.pathname);

    if (isHtmlPageRequest(request))
    {
        try
        {
            return await fetchPageWithNonce(request, securityHeaders, nonce);
        }
        catch (error)
        {
            // Replace with your logger
            console.error({
                error,
                path: request.nextUrl.pathname,
                context: "middleware - nonce injection error, serving page without nonce"
            });
        }
    }

    const response = NextResponse.next();
    applySecurityHeaders(response.headers, securityHeaders, nonce);
    return response;
}

export const config = {
    matcher: [{
      // Skip all internal paths and paths with a '.'
      source: '/((?!.*\\.|api|assets|preview|_next\\/static|_next\\/image|_vercel).*)',
      // Skip the inner page fetch made by this middleware, so it is not invoked twice per page
      missing: [{ type: 'header', key: 'x-csp-passthrough' }]
    }]
};

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
            signal: AbortSignal.timeout(headerFetchTimeoutMs)
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

function isCspHeader(key: string): boolean
{
    return cspHeaderNames.includes(key.toLowerCase());
}

function generateNonce(): string
{
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
}

/**
 * Only full HTML page loads need the nonce injected. Client side navigations
 * request the React Server Component payload instead, identified by the RSC header.
 */
function isHtmlPageRequest(request: NextRequest): boolean
{
    return request.method === 'GET'
        && (request.headers.get('accept') ?? '').includes('text/html')
        && !request.headers.has('rsc');
}

/**
 * Fetches the requested page, from the cache for static routes, and returns it
 * with the security headers applied and the nonce injected into its HTML.
 */
async function fetchPageWithNonce(request: NextRequest, securityHeaders: SecurityHeader[], nonce: string): Promise<NextResponse>
{
    const pageHeaders = new Headers(request.headers);
    pageHeaders.set(passthroughHeader, '1');
    const page = await fetch(request.url, { headers: pageHeaders, redirect: 'manual' });

    const responseHeaders = new Headers(page.headers);
    // The body is decoded and re-streamed, so these no longer describe it
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    responseHeaders.delete('transfer-encoding');
    applySecurityHeaders(responseHeaders, securityHeaders, nonce);

    const isHtml = (page.headers.get('content-type') ?? '').includes('text/html');
    const body = isHtml && page.body ? page.body.pipeThrough(nonceTransform(nonce)) : page.body;
    return new NextResponse(body, { status: page.status, headers: responseHeaders });
}

/**
 * Adds the nonce to every script and style tag in a chunk of HTML, replacing
 * any nonce attribute that is already present.
 */
function injectNonce(html: string, nonce: string): string
{
    return html.replace(/<(script|style)\b([^>]*)>/gi, (_, tag: string, attrs: string) => {
        const cleaned = attrs.replace(/\s+nonce=("[^"]*"|'[^']*'|[^\s>]*)/i, '');
        return `<${tag} nonce="${nonce}"${cleaned}>`;
    });
}

/**
 * Streams HTML through injectNonce without buffering the whole page. A tag
 * that is split across two chunks is held back until the closing '>' arrives.
 */
function nonceTransform(nonce: string): TransformStream<Uint8Array, Uint8Array>
{
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let carry = '';
    return new TransformStream({
        transform(chunk, controller)
        {
            let text = carry + decoder.decode(chunk, { stream: true });
            const lastOpen = text.lastIndexOf('<');
            if (lastOpen > text.lastIndexOf('>'))
            {
                carry = text.slice(lastOpen);
                text = text.slice(0, lastOpen);
            }
            else
                carry = '';
            controller.enqueue(encoder.encode(injectNonce(text, nonce)));
        },
        flush(controller)
        {
            const rest = carry + decoder.decode();
            if (rest)
                controller.enqueue(encoder.encode(injectNonce(rest, nonce)));
        }
    });
}
