import { Webhook } from 'standardwebhooks';
import DodoPayments from 'dodopayments';

const PRODUCT_ID = 'pdt_eCqU7zSrzmDHYstrWiYwu';
const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000; // 1 day in milliseconds

// ADD DEFAULT EXPORT HERE
export default {
    async fetch(request, env, ctx) {
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

        if (url.pathname === '/checkout' && method === 'GET') {
            const email = url.searchParams.get('email');
            const baseUrl = (env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode') 
                ? 'https://checkout.dodopayments.com/buy' 
                : 'https://test.checkout.dodopayments.com/buy';
            
            const successUrlBase = env.DODO_PAYMENTS_RETURN_URL || `${url.origin}/success`;
            const successUrl = new URL(successUrlBase);

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
                            hasAccess: true, 
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
};

function generateAppPage(email, accessType, expiryDate) {
    const trialBanner = accessType === 'trial' ? `
        <div class="status-banner trial">
            <div class="banner-content">
                <div class="banner-left">
                    <span class="badge">FREE TRIAL</span>
                    <span class="banner-text">Expires: ${new Date(expiryDate).toLocaleString()}</span>
                </div>
                <a href="/checkout?email=${encodeURIComponent(email)}" class="upgrade-btn">
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                        <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                        <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
                    </svg>
                    Upgrade to Pro
                </a>
            </div>
        </div>
    ` : '';
    
    const subscriptionBanner = accessType === 'paid' ? `
        <div class="status-banner paid">
            <div class="banner-content">
                <div class="banner-left">
                    <span class="badge pro">PRO</span>
                    <span class="banner-text">Active until ${new Date(expiryDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                </div>
                <span class="user-email">${email}</span>
            </div>
        </div>
    ` : '';

    return `<!DOCTYPE html>
<html>
<head>
    <title>AI Content Humanizer - Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
        }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            overflow: hidden;
        }
        
        .status-banner {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 10000;
            padding: 12px 24px;
            background: rgba(10, 25, 47, 0.85); /* Matching header-bg from your theme */
            backdrop-filter: blur(8px);
            border-bottom: 1px solid #1d3150; /* Matching border-color from your theme */
            animation: slideDown 0.3s ease-out;
        }
        
        @keyframes slideDown {
            from { transform: translateY(-100%); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
        
        .banner-content {
            max-width: 1400px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: #ccd6f6; /* Matching text-primary from your theme */
        }
        
        .banner-left { display: flex; align-items: center; gap: 16px; }
        
        .badge {
            background: rgba(100, 255, 218, 0.1); /* Teal accent */
            color: #64ffda;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            border: 1px solid rgba(100, 255, 218, 0.2);
        }
        
        .banner-text { font-size: 14px; font-weight: 500; color: #8892b0; }
        
        .upgrade-btn {
            display: flex;
            align-items: center;
            gap: 8px;
            background-color: #64ffda; /* Teal accent */
            color: #0A192F; /* Dark blue text */
            padding: 10px 24px;
            border-radius: 24px;
            text-decoration: none;
            font-weight: 600;
            font-size: 14px;
            transition: all 0.2s ease;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        
        .upgrade-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(100, 255, 218, 0.2);
            background-color: #52c4b3;
        }
        
        .iframe-container {
            position: fixed;
            top: 57px; /* Adjusted for banner height */
            left: 0;
            right: 0;
            bottom: 0;
            /* THIS IS THE KEY CHANGE: Matching your theme's background */
            background: #0A192F; 
        }
        
        iframe {
            width: 100%;
            height: 100%;
            border: none;
            display: block;
        }

        
        /* Custom modal for upgrade prompts */
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(4px);
            z-index: 20000;
            animation: fadeIn 0.2s ease-out;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        
        .modal-overlay.active {
            display: flex;
            justify-content: center;
            align-items: center;
        }
        
        .modal {
            background: white;
            border-radius: 16px;
            padding: 32px;
            max-width: 480px;
            width: 90%;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            animation: slideUp 0.3s ease-out;
        }
        
        @keyframes slideUp {
            from {
                transform: translateY(40px);
                opacity: 0;
            }
            to {
                transform: translateY(0);
                opacity: 1;
            }
        }
        
        .modal-icon {
            width: 64px;
            height: 64px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
            font-size: 32px;
        }
        
        .modal h2 {
            font-size: 24px;
            margin-bottom: 12px;
            text-align: center;
            color: #1a1a1a;
        }
        
        .modal p {
            font-size: 15px;
            line-height: 1.6;
            color: #666;
            text-align: center;
            margin-bottom: 24px;
        }
        
        .modal-buttons {
            display: flex;
            gap: 12px;
        }
        
        .modal-btn {
            flex: 1;
            padding: 14px 24px;
            border: none;
            border-radius: 10px;
            font-weight: 600;
            font-size: 15px;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        
        .modal-btn.primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        
        .modal-btn.primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(102, 126, 234, 0.3);
        }
        
        .modal-btn.secondary {
            background: #f5f5f5;
            color: #666;
        }
        
        .modal-btn.secondary:hover {
            background: #e5e5e5;
        }
        
        @media (max-width: 768px) {
            .banner-content {
                flex-direction: column;
                gap: 12px;
            }
            
            .banner-left {
                flex-direction: column;
                gap: 8px;
                text-align: center;
            }
            
            .status-banner {
                padding: 16px;
            }
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
    
    <div class="modal-overlay" id="upgradeModal">
        <div class="modal">
            <div class="modal-icon">🔒</div>
            <h2>Premium Feature</h2>
            <p>This feature is only available for Pro subscribers. Upgrade now to unlock all features and get unlimited access!</p>
            <div class="modal-buttons">
                <button class="modal-btn secondary" onclick="closeModal()">Maybe Later</button>
                <button class="modal-btn primary" onclick="upgradeNow()">Upgrade to Pro</button>
            </div>
        </div>
    </div>
    
    <script>
        const email = "${email}";
        const accessType = "${accessType}";
        
        function closeModal() {
            document.getElementById('upgradeModal').classList.remove('active');
        }
        
        function upgradeNow() {
            window.location.href = '/checkout?email=' + encodeURIComponent(email);
        }
        
        window.addEventListener('message', async (event) => {
            if (event.origin !== 'https://demo.imaginea.store') return;
            
            if (event.data.type === 'BUTTON_CLICK') {
                const buttonName = event.data.button;
                
                if (accessType === 'trial' && 
                    (buttonName === 'printDashboard' || buttonName === 'analysis')) {
                    event.source.postMessage({
                        type: 'BUTTON_BLOCKED',
                        message: 'This feature requires a paid subscription',
                        showUpgrade: true
                    }, event.origin);
                    
                    document.getElementById('upgradeModal').classList.add('active');
                } else if (accessType === 'paid') {
                    event.source.postMessage({
                        type: 'BUTTON_ALLOWED',
                        button: buttonName
                    }, event.origin);
                }
            }
        });
        
        const iframe = document.getElementById('appFrame');
        iframe.addEventListener('load', () => {
            iframe.contentWindow.postMessage({
                type: 'ACCESS_LEVEL',
                accessType: accessType,
                email: email
            }, 'https://demo.imaginea.store');
        });
        
        // Close modal on overlay click
        document.getElementById('upgradeModal').addEventListener('click', (e) => {
            if (e.target.id === 'upgradeModal') {
                closeModal();
            }
        });
    </script>
</body>
</html>`;
}

function generateExpiredPage(email) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Trial Expired - Upgrade to Continue</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
        }
        
        .container {
            max-width: 560px;
            width: 100%;
            background: white;
            padding: 48px;
            border-radius: 24px;
            box-shadow: 0 25px 80px rgba(0, 0, 0, 0.25);
            text-align: center;
            animation: slideIn 0.4s ease-out;
        }
        
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #ffeaa7 0%, #fdcb6e 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
            margin: 0 auto 24px;
            box-shadow: 0 8px 24px rgba(253, 203, 110, 0.3);
        }
        
        h1 {
            color: #1a1a1a;
            font-size: 28px;
            margin-bottom: 12px;
            font-weight: 700;
        }
        
        .subtitle {
            color: #666;
            font-size: 16px;
            margin-bottom: 32px;
            line-height: 1.6;
        }
        
        .features {
            background: #f8f9fa;
            border-radius: 16px;
            padding: 28px;
            margin: 32px 0;
            text-align: left;
        }
        
        .features-title {
            font-size: 18px;
            font-weight: 700;
            color: #1a1a1a;
            margin-bottom: 20px;
            text-align: center;
        }
        
        .feature-item {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            margin-bottom: 16px;
            color: #444;
            font-size: 15px;
            line-height: 1.5;
        }
        
        .feature-item:last-child {
            margin-bottom: 0;
        }
        
        .feature-icon {
            width: 24px;
            height: 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 14px;
            flex-shrink: 0;
            margin-top: 2px;
        }
        
        .button {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 16px 48px;
            border-radius: 12px;
            text-decoration: none;
            font-weight: 600;
            font-size: 16px;
            box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
            transition: all 0.3s ease;
            margin-top: 8px;
        }
        
        .button:hover {
            transform: translateY(-3px);
            box-shadow: 0 12px 32px rgba(102, 126, 234, 0.5);
        }
        
        .button:active {
            transform: translateY(-1px);
        }
        
        .price {
            margin-top: 24px;
            color: #888;
            font-size: 14px;
        }
        
        .price strong {
            color: #667eea;
            font-size: 20px;
        }
        
        @media (max-width: 640px) {
            .container {
                padding: 32px 24px;
            }
            
            h1 {
                font-size: 24px;
            }
            
            .button {
                width: 100%;
                padding: 16px 32px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">⏰</div>
        <h1>Your Trial Has Ended</h1>
        <p class="subtitle">Thanks for trying AI Content Humanizer! Your 24-hour free trial has expired. Upgrade now to continue using all features.</p>
        
        <div class="features">
            <div class="features-title">Unlock Pro Features</div>
            <div class="feature-item">
                <div class="feature-icon">✓</div>
                <div><strong>Unlimited humanization</strong> - Transform any AI content instantly</div>
            </div>
            <div class="feature-item">
                <div class="feature-icon">✓</div>
                <div><strong>Advanced analysis tools</strong> - Deep insights & tracking</div>
            </div>
            <div class="feature-item">
                <div class="feature-icon">✓</div>
                <div><strong>Export & print</strong> - Download and share your content</div>
            </div>
            <div class="feature-item">
                <div class="feature-icon">✓</div>
                <div><strong>Priority support</strong> - Get help whenever you need it</div>
            </div>
        </div>
        
        <a href="/checkout?email=${encodeURIComponent(email)}" class="button">
            Upgrade to Pro
        </a>
        
        <div class="price">
            Starting at <strong>$9.99/month</strong>
        </div>
    </div>
</body>
</html>`;
}

function generateHtmlPage(title, bodyContent) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
        }
        
        .container {
            max-width: 480px;
            width: 100%;
            background: white;
            padding: 48px;
            border-radius: 24px;
            box-shadow: 0 25px 80px rgba(0, 0, 0, 0.25);
            text-align: center;
            animation: slideIn 0.4s ease-out;
        }
        
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .logo {
            width: 72px;
            height: 72px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            margin: 0 auto 24px;
            box-shadow: 0 8px 24px rgba(102, 126, 234, 0.3);
        }
        
        h1 {
            color: #1a1a1a;
            font-size: 28px;
            margin-bottom: 12px;
            font-weight: 700;
        }
        
        p {
            color: #666;
            font-size: 15px;
            margin-bottom: 32px;
            line-height: 1.6;
        }
        
        p strong {
            color: #667eea;
            font-weight: 600;
        }
        
        form {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        
        input {
            padding: 16px 20px;
            width: 100%;
            border-radius: 12px;
            border: 2px solid #e5e7eb;
            font-size: 16px;
            transition: all 0.2s ease;
            font-family: inherit;
        }
        
        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.1);
        }
        
        input::placeholder {
            color: #9ca3af;
        }
        
        button, .button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 16px 32px;
            border: none;
            border-radius: 12px;
            cursor: pointer;
            font-size: 16px;
            font-weight: 600;
            box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-block;
            font-family: inherit;
        }
        
        button:hover, .button:hover {
            transform: translateY(-3px);
            box-shadow: 0 12px 32px rgba(102, 126, 234, 0.5);
        }
        
        button:active, .button:active {
            transform: translateY(-1px);
        }
        
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        
        .feature-list {
            background: #f8f9fa;
            border-radius: 16px;
            padding: 24px;
            margin: 24px 0;
            text-align: left;
        }
        
        .feature-list ul {
            list-style: none;
        }
        
        .feature-list li {
            padding: 8px 0;
            color: #444;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .feature-list li:before {
            content: "✓";
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-radius: 50%;
            font-size: 12px;
            font-weight: bold;
            flex-shrink: 0;
        }
        
        @media (max-width: 640px) {
            .container {
                padding: 32px 24px;
            }
            
            h1 {
                font-size: 24px;
            }
            
            .logo {
                width: 64px;
                height: 64px;
                font-size: 32px;
            }
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