export async function registerWebhooks({ shop, accessToken }) {
    const topics = ["discounts/create", "discounts/update", "discounts/delete"];

    const baseUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
    const webhookUrl = `${baseUrl}/api/webhooks/shopify/discounts`;

    for (const topic of topics) {
        try {
            const response = await fetch(
                `https://${shop}/admin/api/2024-01/webhooks.json`,
                {
                    method: "POST",
                    headers: {
                        "X-Shopify-Access-Token": accessToken,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        webhook: {
                            topic,
                            address: webhookUrl,
                            format: "json",
                        },
                    }),
                },
            );

            const text = await response.text();

            console.log(`[Webhook Created] ${topic}`, response.status, text);
        } catch (error) {
            console.error(`[Webhook ERROR] ${topic}`, error);
        }
    }
}
