import React, { useState, useEffect, useCallback } from "react";
import {
  Page, Layout, Card, FormLayout, TextField, Checkbox,
  Button, ButtonGroup, Banner, Spinner, Text, BlockStack,
  InlineStack, Badge, Divider, Box,
} from "@shopify/polaris";
import { useAuthenticatedFetch } from "../hooks/useAuthenticatedFetch";

const PAID_STATUS_OPTIONS = [
  { label: "Paid", value: "paid" },
  { label: "Partially Paid", value: "partially_paid" },
  { label: "Pending", value: "pending" },
  { label: "Refunded", value: "refunded" },
  { label: "Voided", value: "voided" },
];

const DEFAULT_SETTINGS = {
  webhook_url: "",
  webhook_secret: "",
  has_secret: false,
  paid_statuses: ["paid"],
  param_names: "click_id",
  cookie_name: "_ht_click_id",
  cookie_days: "30",
  debug: false,
  test_mode: false,
  has_mystorefront_api_key: false,
  mystorefront_api_key: "",
  has_shopify_admin_token: false,
};

export default function SettingsPage() {
  const fetch = useAuthenticatedFetch();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [generateResult, setGenerateResult] = useState(null);
  const [errors, setErrors] = useState({});
  const [shopDomain, setShopDomain] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      setSettings({
        ...DEFAULT_SETTINGS,
        ...data,
        webhook_secret: "",
        cookie_days: String(data.cookie_days || 30),
      });
      const url = new URL(window.location.href);
      setShopDomain(url.searchParams.get("shop") || "");
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }, [fetch]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const validate = () => {
    const e = {};
    if (!settings.webhook_url) {
      e.webhook_url = "Webhook URL is required.";
    } else if (!settings.webhook_url.startsWith("https://")) {
      e.webhook_url = "Webhook URL must start with https://";
    }
    if (!settings.has_secret && !settings.webhook_secret) {
      e.webhook_secret = "Webhook Secret is required.";
    }
    return e;
  };

  const handleSave = async () => {
    const e = validate();
    if (Object.keys(e).length > 0) { setErrors(e); return; }
    setErrors({});
    setSaving(true);
    setSaveResult(null);
    try {
      const body = { ...settings, cookie_days: parseInt(settings.cookie_days, 10) || 30 };
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setSettings((prev) => ({
          ...prev,
          ...data.settings,
          webhook_secret: "",
          cookie_days: String(data.settings.cookie_days),
        }));
        setSaveResult({ type: "success", message: "Settings saved successfully." });
      } else {
        setSaveResult({ type: "critical", message: data.error || "Failed to save settings." });
      }
    } catch (err) {
      setSaveResult({ type: "critical", message: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/test", { method: "POST" });
      const data = await res.json();
      setTestResult({ success: data.success, message: data.message || data.error });
    } catch (err) {
      setTestResult({ success: false, message: "Network error during test." });
    } finally {
      setTesting(false);
    }
  };

  const handleGenerateApiKey = async () => {
    if (!window.confirm("Generating a new key will invalidate the old one. Continue?")) return;
    setGeneratingKey(true);
    setGenerateResult(null);
    try {
      const res = await fetch("/api/settings/generate-api-key", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setSettings((prev) => ({ ...prev, mystorefront_api_key: data.key, has_mystorefront_api_key: true }));
        setGenerateResult({ type: "success", message: "New key generated and saved." });
      } else {
        setGenerateResult({ type: "critical", message: data.error || "Failed to generate key." });
      }
    } catch (err) {
      setGenerateResult({ type: "critical", message: "Network error." });
    } finally {
      setGeneratingKey(false);
    }
  };

  const togglePaidStatus = (value) => {
    const current = settings.paid_statuses || [];
    const next = current.includes(value)
      ? current.filter((s) => s !== value)
      : [...current, value];
    setSettings((prev) => ({ ...prev, paid_statuses: next }));
  };

  const appBaseUrl = window.location.origin;
  const incomingWebhookUrl = `${appBaseUrl}/api/discount-codes`;

  if (loading) {
    return (
      <Page title="MyStorefront Postback">
        <Layout><Layout.Section><Card>
          <BlockStack inlineAlign="center" gap="400"><Spinner /><Text>Loading settings...</Text></BlockStack>
        </Card></Layout.Section></Layout>
      </Page>
    );
  }

  return (
    <Page
      title="MyStorefront Postback"
      subtitle="Send conversion postbacks and sync discount codes with MyStorefront."
      primaryAction={{ content: "Save", onAction: handleSave, loading: saving }}
    >
      <Layout>
        {saveResult && (
          <Layout.Section>
            <Banner status={saveResult.type === "success" ? "success" : "critical"} onDismiss={() => setSaveResult(null)}>
              {saveResult.message}
            </Banner>
          </Layout.Section>
        )}

        {/* Webhook Configuration */}
        <Layout.AnnotatedSection
          title="Webhook Configuration"
          description="Enter your MyStorefront webhook endpoint and secret. The secret is sent as the x-webhook-secret header on every postback."
        >
          <Card>
            <FormLayout>
              <TextField
                label="Webhook URL"
                value={settings.webhook_url}
                onChange={(v) => setSettings((p) => ({ ...p, webhook_url: v }))}
                placeholder="https://..."
                error={errors.webhook_url}
                autoComplete="off"
                type="url"
                helpText="Must start with https://"
              />
              <TextField
                label={settings.has_secret ? "Webhook Secret (saved — enter new value to change)" : "Webhook Secret"}
                value={settings.webhook_secret}
                onChange={(v) => setSettings((p) => ({ ...p, webhook_secret: v }))}
                type="password"
                placeholder={settings.has_secret ? "••••••••••••••••••••" : "Enter your webhook secret"}
                error={errors.webhook_secret}
                autoComplete="new-password"
                helpText="Stored securely and never displayed after saving."
              />
              <Box paddingBlockStart="200">
                <BlockStack gap="200">
                  <Text variant="bodyMd" fontWeight="semibold">Test Connection</Text>
                  <InlineStack gap="300" align="start" blockAlign="center">
                    <Button onClick={handleTest} loading={testing} disabled={!settings.webhook_url}>
                      Send Test Postback
                    </Button>
                    {testResult && (
                      <Badge status={testResult.success ? "success" : "critical"}>{testResult.message}</Badge>
                    )}
                  </InlineStack>
                </BlockStack>
              </Box>
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        {/* MyStorefront Discount Code Sync */}
        <Layout.AnnotatedSection
          title="MyStorefront Discount Code Sync"
          description="Allow MyStorefront to automatically create discount codes on this store. Copy both values into your MyStorefront Brand Settings."
        >
          <Card>
            <BlockStack gap="500">

              {/* Shopify Admin API Token — set automatically via OAuth, no manual input needed */}
              <BlockStack gap="200">
                <Text variant="bodyMd" fontWeight="semibold">Shopify API Access</Text>
                {settings.has_shopify_admin_token ? (
                  <InlineStack gap="200" blockAlign="center">
                    <Badge status="success">Connected</Badge>
                    <Text variant="bodySm" color="subdued">
                      Shopify granted access automatically when you installed the app. Discount code sync is ready.
                    </Text>
                  </InlineStack>
                ) : (
                  <InlineStack gap="200" blockAlign="center">
                    <Badge status="warning">Not connected</Badge>
                    <Text variant="bodySm" color="subdued">
                      Reinstall the app from the Shopify App Store to grant discount code access automatically.
                    </Text>
                  </InlineStack>
                )}
              </BlockStack>

              <Divider />

              {/* MyStorefront API Key */}
              <BlockStack gap="200">
                <Text variant="bodyMd" fontWeight="semibold">MyStorefront API Key</Text>
                <InlineStack gap="300" blockAlign="center" wrap>
                  <div style={{ flex: 1, minWidth: 280 }}>
                    <TextField
                      label="API Key"
                      labelHidden
                      value={settings.mystorefront_api_key}
                      readOnly
                      placeholder={settings.has_mystorefront_api_key ? "Key saved" : "Click Generate to create a key"}
                      autoComplete="off"
                      monospaced
                    />
                  </div>
                  <Button onClick={handleGenerateApiKey} loading={generatingKey}>
                    Generate New Key
                  </Button>
                </InlineStack>
                {generateResult && (
                  <Banner
                    status={generateResult.type === "success" ? "success" : "critical"}
                    onDismiss={() => setGenerateResult(null)}
                  >
                    {generateResult.message}
                  </Banner>
                )}
                <Text variant="bodySm" color="subdued">
                  Paste this key into MyStorefront Brand Settings → Discount Code Sync → API Key.
                </Text>
              </BlockStack>

              <Divider />

              {/* Incoming Webhook URL */}
              <BlockStack gap="200">
                <Text variant="bodyMd" fontWeight="semibold">Incoming Webhook URL</Text>
                <TextField
                  label="Incoming Webhook URL"
                  labelHidden
                  value={incomingWebhookUrl}
                  readOnly
                  autoComplete="off"
                  monospaced
                />
                <Text variant="bodySm" color="subdued">
                  Paste this URL into MyStorefront Brand Settings → Discount Code Sync → Incoming Webhook URL.
                </Text>
              </BlockStack>

            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* Attribution Settings */}
        <Layout.AnnotatedSection
          title="Attribution Settings"
          description="Configure how click IDs are captured from your storefront URLs and stored in cookies."
        >
          <Card>
            <FormLayout>
              <TextField
                label="Attribution Parameter Names"
                value={settings.param_names}
                onChange={(v) => setSettings((p) => ({ ...p, param_names: v }))}
                helpText="Comma-separated URL parameter names. Default: click_id"
                autoComplete="off"
                placeholder="click_id"
              />
              <TextField
                label="Cookie Name"
                value={settings.cookie_name}
                onChange={(v) => setSettings((p) => ({ ...p, cookie_name: v }))}
                helpText="First-party cookie name. Default: _ht_click_id"
                autoComplete="off"
                placeholder="_ht_click_id"
              />
              <TextField
                label="Cookie Duration (days)"
                value={settings.cookie_days}
                onChange={(v) => setSettings((p) => ({ ...p, cookie_days: v }))}
                type="number"
                min={1}
                max={365}
                helpText="How long the click ID cookie persists. Default: 30 days."
                autoComplete="off"
              />
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        {/* Conversion Triggers */}
        <Layout.AnnotatedSection
          title="Conversion Triggers"
          description="Select which Shopify financial statuses should trigger a postback."
        >
          <Card>
            <BlockStack gap="300">
              <Text variant="bodyMd">Send postback when order financial status is:</Text>
              <BlockStack gap="200">
                {PAID_STATUS_OPTIONS.map((opt) => (
                  <Checkbox
                    key={opt.value}
                    label={opt.label}
                    checked={(settings.paid_statuses || []).includes(opt.value)}
                    onChange={() => togglePaidStatus(opt.value)}
                  />
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* Advanced */}
        <Layout.AnnotatedSection
          title="Advanced"
          description="Debug logging redacts customer PII. Test mode sets 'test: true' in all payloads."
        >
          <Card>
            <FormLayout>
              <Checkbox
                label="Enable debug logging"
                helpText="Logs postback requests and responses to your server console."
                checked={settings.debug}
                onChange={(v) => setSettings((p) => ({ ...p, debug: v }))}
              />
              <Checkbox
                label="Test mode"
                helpText='Sets "test": true in all postback payloads.'
                checked={settings.test_mode}
                onChange={(v) => setSettings((p) => ({ ...p, test_mode: v }))}
              />
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        {/* Storefront Script */}
        <Layout.AnnotatedSection
          title="Storefront Script"
          description="Add this script to your Shopify theme to capture click IDs from URL parameters."
        >
          <Card>
            <BlockStack gap="300">
              <Text variant="bodyMd">
                Add to your theme's <code>{"<head>"}</code> or via <strong>Online Store → Themes → Edit Code</strong>:
              </Text>
              <Box background="bg-surface-secondary" padding="400" borderRadius="100">
                <Text as="p" variant="bodyMd" fontFamily="mono">
                  {`<script src="${appBaseUrl}/pixel/${shopDomain || "YOUR_STORE.myshopify.com"}/capture.js" async></script>`}
                </Text>
              </Box>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* Save footer */}
        <Layout.Section>
          <Box paddingBlockEnd="800">
            <ButtonGroup>
              <Button variant="primary" onClick={handleSave} loading={saving}>Save Settings</Button>
            </ButtonGroup>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
