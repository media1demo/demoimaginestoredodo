import { Webhook } from 'standardwebhooks';
import DodoPayments from 'dodopayments';

const PRODUCT_ID = 'pdt_eCqU7zSrzmDHYstrWiYwu';
const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000; // 1 day in milliseconds

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const method = request.method;
    const kv = env.SUBSCRIPTIONS_KV;

    if (!kv) {
        console.error('[ERROR] KV storage is not bound!');
        return new Response("KV storage is not bound. Please check your Cloudflare settings.", { status: 500 });
    }

    // --- ROUTE 1: WEBHOOK HANDLER ---
    if (url.pathname === '/api/webhook' && method === 'POST') {
        try {
            const secret = env.DODO_PAYMENTS_WEBHOOK_KEY;
            if (!secret) {
                console.error('[ERROR] Webhook secret not configured');
                throw new Error("Webhook secret not configured.");
            }

            const bodyText = await request.text();
            console.log('[Webhook] Received webhook payload');
            
            const headers = {};
            request.headers.forEach((value, key) => {
                headers[key] = value;
            });
            
            const wh = new Webhook(secret);
            const payload = wh.verify(bodyText, headers);
            
            console.log(`[Webhook] ✅ Verified! Event: ${payload.type}`);
            
            const email = payload.data.customer?.email;
            
            if (!email) {
                console.warn('[Webhook] ⚠️ No email found in webhook payload!');
                return new Response(JSON.stringify({ status: 'success', warning: 'no email' }), { status: 200 });
            }

            console.log(`[Webhook] Processing for email: ${email}`);

            const currentUserData = await kv.get(email, { type: "json" }) || { 
                hasPaid: false, 
                trialStarted: null,
                subscriptions: null 
            };

            if (payload.type === 'payment.succeeded') {
                currentUserData.hasPaid = true;
                currentUserData.paymentDate = new Date(payload.timestamp).toISOString();
                console.log(`[KV] ✅ Payment succeeded for ${email}`);
            } 
            else if (payload.type === 'subscription.active' || payload.type === 'subscription.renewed') {
                currentUserData.hasPaid = true;
                currentUserData.subscriptions = {
                    status: 'active',
                    next_billing_date: payload.data.next_billing_date,
                    product_id: payload.data.product_id,
                    started_at: new Date(payload.timestamp).toISOString()
                };
                console.log(`[KV] ✅ Updated subscription status for ${email}`);
            } 
            else if (payload.type === 'subscription.cancelled' && currentUserData.subscriptions) {
                currentUserData.subscriptions.status = 'cancelled';
                currentUserData.hasPaid = false;
                console.log(`[KV] ℹ️ Marked subscription as cancelled for ${email}`);
            }
            
            await kv.put(email, JSON.stringify(currentUserData));
            console.log(`[KV] ✅ Data saved for ${email}`);
            
            return new Response(JSON.stringify({ status: 'success', email: email }), { 
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (err) {
            console.error('❌ Webhook failed:', err);
            return new Response(JSON.stringify({ error: err.message }), { 
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
    
    // --- ROUTE 2: HOME PAGE ---
    if (url.pathname === '/' && method === 'GET') {
        const email = url.searchParams.get('email');
        if (email) {
            console.log(`[Home] Checking access for: ${email}`);
            const userData = await kv.get(email, { type: "json" });
            console.log(`[Home] User data:`, JSON.stringify(userData));
            
            // Check if user has paid
            if (userData?.hasPaid && userData?.subscriptions?.status === 'active') {
                // Full access - paid subscriber
                const subscriptionEnd = new Date(userData.subscriptions.next_billing_date);
                return new Response(generateAppPage(email, 'paid', subscriptionEnd.toISOString()), { 
                    headers: { 'Content-Type': 'text/html' } 
                });
            } else {
                // Check trial status
                const now = Date.now();
                if (!userData?.trialStarted) {
                    // Start trial
                    const trialData = {
                        hasPaid: false,
                        trialStarted: new Date().toISOString(),
                        subscriptions: null
                    };
                    await kv.put(email, JSON.stringify(trialData));
                    return new Response(generateAppPage(email, 'trial', trialData.trialStarted), { 
                        headers: { 'Content-Type': 'text/html' } 
                    });
                } else {
                    // Check if trial expired
                    const trialStart = new Date(userData.trialStarted).getTime();
                    const trialEnd = trialStart + TRIAL_DURATION_MS;
                    
                    if (now < trialEnd) {
                        // Trial still active
                        return new Response(generateAppPage(email, 'trial', userData.trialStarted), { 
                            headers: { 'Content-Type': 'text/html' } 
                        });
                    } else {
                        // Trial expired
                        return new Response(generateExpiredPage(email), { 
                            headers: { 'Content-Type': 'text/html' } 
                        });
                    }
                }
            }
        } else {
            const emailFormHtml = `
                <h1>AI Content Humanizer</h1>
                <p>Enter your email to start your <strong>FREE 1-day trial</strong></p>
                <form action="/" method="GET">
                    <input type="email" name="email" required placeholder="your@email.com" />
                    <br/>
                    <button type="submit">Start Free Trial</button>
                </form>
            `;
            return new Response(generateHtmlPage("Start Free Trial", emailFormHtml), { 
                headers: { 'Content-Type': 'text/html' } 
            });
        }
    }

    // --- ROUTE 3: CHECKOUT REDIRECT ---
    if (url.pathname === '/checkout' && method === 'GET') {
        const email = url.searchParams.get('email');
        const baseUrl = (env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode') 
            ? 'https://checkout.dodopayments.com/buy' 
            : 'https://test.checkout.dodopayments.com/buy';
        
        const successUrl = new URL(`${url.origin}/success`);
        if (email) successUrl.searchParams.append('email', email);
        const returnUrl = encodeURIComponent(successUrl.toString());
        
        let checkoutUrl = `${baseUrl}/${PRODUCT_ID}?quantity=1&redirect_url=${returnUrl}`;
        if (email) checkoutUrl += `&email=${encodeURIComponent(email)}`;
        
        console.log(`[Checkout] Redirecting to: ${checkoutUrl}`);
        return Response.redirect(checkoutUrl, 302);
    }
    
    // --- ROUTE 4: SUCCESS PAGE ---
    if (url.pathname === '/success' && method === 'GET') {
        const status = url.searchParams.get('status');
        const customerEmail = url.searchParams.get('email') || '';

        console.log(`[Success] Status: ${status}, Email: ${customerEmail}`);

        if (status !== 'succeeded' && status !== 'active') {
            const failureHtml = `
                <h1>Payment Failed</h1>
                <p>Your payment was not successful. Status: <strong>${status || 'unknown'}</strong></p>
                <p>You can continue using the free trial or try payment again.</p>
                <a href="/?email=${encodeURIComponent(customerEmail)}" class="button">Back to App</a>
            `;
            return new Response(generateHtmlPage("Payment Failed", failureHtml), { 
                status: 400, 
                headers: { 'Content-Type': 'text/html' } 
            });
        }
        
        // Payment successful - redirect to app
        const homeUrl = new URL(url.origin);
        if (customerEmail) {
            homeUrl.searchParams.set('email', customerEmail);
        }
        return Response.redirect(homeUrl.toString(), 302);
    }

    // --- ROUTE 5: API CHECK ACCESS ---
    if (url.pathname === '/api/check-access' && method === 'POST') {
        try {
            const body = await request.json();
            const email = body.email;
            
            if (!email) {
                return new Response(JSON.stringify({ hasAccess: false, reason: 'no_email' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const userData = await kv.get(email, { type: "json" });
            
            // Check if paid
            if (userData?.hasPaid && userData?.subscriptions?.status === 'active') {
                return new Response(JSON.stringify({ 
                    hasAccess: true, 
                    type: 'paid',
                    expiresAt: userData.subscriptions.next_billing_date
                }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            
            // Check trial
            if (userData?.trialStarted) {
                const trialStart = new Date(userData.trialStarted).getTime();
                const trialEnd = trialStart + TRIAL_DURATION_MS;
                const now = Date.now();
                
                if (now < trialEnd) {
                    return new Response(JSON.stringify({ 
                        hasAccess: false, 
                        type: 'trial',
                        expiresAt: new Date(trialEnd).toISOString()
                    }), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            }
            
            return new Response(JSON.stringify({ 
                hasAccess: false, 
                type: 'expired' 
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    return new Response('Page Not Found.', { status: 404 });
}

function generateAppPage(email, accessType, expiryDate) {
    const trialBanner = accessType === 'trial' ? `
        <div class="trial-banner">
            🎉 You're on a FREE trial! Expires: ${new Date(expiryDate).toLocaleString()}
            <a href="/checkout?email=${encodeURIComponent(email)}" class="upgrade-btn">Upgrade Now</a>
        </div>
    ` : '';
    
    const subscriptionBanner = accessType === 'paid' ? `
        <div class="paid-banner">
            ✅ Active Subscription | Next billing: ${new Date(expiryDate).toLocaleDateString()}
        </div>
    ` : '';

    return `<!DOCTYPE html>
<html>
<head>
    <title>AI Content Humanizer</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        
        .trial-banner {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px;
            text-align: center;
            font-weight: bold;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 1000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        
        .paid-banner {
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
            color: white;
            padding: 15px;
            text-align: center;
            font-weight: bold;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 1000;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        
        .upgrade-btn {
            background: white;
            color: #667eea;
            padding: 8px 20px;
            border-radius: 20px;
            text-decoration: none;
            margin-left: 20px;
            font-weight: bold;
            display: inline-block;
        }
        
        .iframe-container {
            position: fixed;
            top: ${accessType === 'trial' || accessType === 'paid' ? '50px' : '0'};
            left: 0;
            right: 0;
            bottom: 0;
            border: none;
        }
        
        iframe {
            width: 100%;
            height: 100%;
            border: none;
        }
    </style>
</head>
<body>
    ${trialBanner}
    ${subscriptionBanner}
    <div class="iframe-container">
        <iframe 
            id="appFrame"
            src="https://demo.imaginea.store/track" 
            allow="clipboard-read; clipboard-write"
            sandbox="allow-same-origin allow-scripts allow-forms"
        ></iframe>
    </div>
    
    <script>
        const email = "${email}";
        const accessType = "${accessType}";
        
        window.addEventListener('message', async (event) => {
            // Security check - only accept messages from demo.imaginea.store
            if (event.origin !== 'https://demo.imaginea.store') return;
            
            if (event.data.type === 'BUTTON_CLICK') {
                const buttonName = event.data.button;
                
                if (accessType === 'trial' && 
                    (buttonName === 'printDashboard' || buttonName === 'analysis')) {
                    // Block button clicks for trial users
                    event.source.postMessage({
                        type: 'BUTTON_BLOCKED',
                        message: 'This feature requires a paid subscription',
                        showUpgrade: true
                    }, event.origin);
                    
                    // Show upgrade prompt
                    if (confirm('This feature is only available for paid subscribers. Would you like to upgrade now?')) {
                        window.location.href = '/checkout?email=' + encodeURIComponent(email);
                    }
                } else if (accessType === 'paid') {
                    // Allow all button clicks for paid users
                    event.source.postMessage({
                        type: 'BUTTON_ALLOWED',
                        button: buttonName
                    }, event.origin);
                }
            }
        });
        
        // Send access level to iframe when it loads
        const iframe = document.getElementById('appFrame');
        iframe.addEventListener('load', () => {
            iframe.contentWindow.postMessage({
                type: 'ACCESS_LEVEL',
                accessType: accessType,
                email: email
            }, 'https://demo.imaginea.store');
        });
    </script>
</body>
</html>`;
}

function generateExpiredPage(email) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Trial Expired</title>
    <style>
        body {
            font-family: sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
            max-width: 500px;
            background: white;
            padding: 50px;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
        }
        h1 {
            color: #333;
            margin-bottom: 20px;
        }
        p {
            color: #666;
            margin-bottom: 30px;
            line-height: 1.6;
        }
        .button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 40px;
            text-decoration: none;
            border-radius: 30px;
            display: inline-block;
            font-weight: bold;
            font-size: 16px;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            transition: transform 0.2s;
        }
        .button:hover {
            transform: translateY(-2px);
        }
        .features {
            text-align: left;
            margin: 30px 0;
            padding: 20px;
            background: #f9f9f9;
            border-radius: 10px;
        }
        .features li {
            margin: 10px 0;
            color: #555;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>⏰ Your Free Trial Has Expired</h1>
        <p>Thanks for trying our AI Content Humanizer! Your 24-hour free trial has ended.</p>
        
        <div class="features">
            <strong>Upgrade to unlock:</strong>
            <ul>
                <li>✅ Unlimited content humanization</li>
                <li>✅ Full dashboard access</li>
                <li>✅ Advanced analysis tools</li>
                <li>✅ Export & print features</li>
            </ul>
        </div>
        
        <a href="/checkout?email=${encodeURIComponent(email)}" class="button">
            Subscribe Now
        </a>
    </div>
</body>
</html>`;
}

function generateHtmlPage(title, bodyContent) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>${title}</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
            max-width: 500px;
            background: white;
            padding: 50px;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
        }
        h1 {
            color: #333;
            margin-bottom: 20px;
        }
        p {
            color: #666;
            margin-bottom: 30px;
        }
        input {
            padding: 15px;
            width: 100%;
            max-width: 350px;
            margin-bottom: 20px;
            border-radius: 10px;
            border: 2px solid #ddd;
            font-size: 16px;
            transition: border 0.3s;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
        }
        button, .button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 40px;
            border: none;
            border-radius: 30px;
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            transition: transform 0.2s;
            text-decoration: none;
            display: inline-block;
        }
        button:hover, .button:hover {
            transform: translateY(-2px);
        }
    </style>
</head>
<body>
    <div class="container">
        ${bodyContent}
    </div>
</body>
</html>`;
}

export default {
    fetch: onRequest
  };
  