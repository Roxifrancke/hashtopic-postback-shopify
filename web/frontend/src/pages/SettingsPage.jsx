import React, { useState, useEffect, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Select,
  Checkbox,
  Button,
  ButtonGroup,
  Banner,
  Spinner,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Divider,
  Box,
  Tag,
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
};

export default function SettingsPage() {
  const fetch = useAuthenticatedFetch();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveResult, setSaveResult] = useState(null); // {type, message}
  const [testResult, setTestResult] = useState(null);
  const [errors, setErrors] = useState({});

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      setSettings({
        ...DEFAULT_SETTINGS,
        ...data,
        webhook_secret: "",
        cookie_days: String(data.cookie_days || 30),
      });
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }, [fetch]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

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
    if (Object.keys(e).length > 0) {
      setErrors(e);
      return;
    }
    setErrors({});
    setSaving(true);
    setSaveResult(null);

    try {
      const body = {
        ...settings,
        cookie_days: parseInt(settings.cookie_days, 10) || 30,
      };
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
          has_secret: data.settings.has_secret,
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
    if (!settings.webhook_url || (!settings.has_secret && !settings.webhook_secret)) {
      setTestResult({ success: false, message: "Save your settings before sending a test postback." });
      return;
    }

    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch("/api/settings/test", { method: "POST" });
      const data = await res.json();
      setTestResult({
        success: data.success,
        message: data.message || data.error,
      });
    } catch (err) {
      setTestResult({ success: false, message: "Network error during test." });
    } finally {
      setTesting(false);
    }
  };

  const togglePaidStatus = (value) => {
    const current = settings.paid_statuses || [];
    const next = current.includes(value)
      ? current.filter((s) => s !== value)
      : [...current, value];
    setSettings((prev) => ({ ...prev, paid_statuses: next }));
  };

  if (loading) {
    return (
      <Page title="HashTopic Postback">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack inlineAlign="center" gap="400">
                <Spinner />
                <Text>Loading settings...</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="HashTopic Postback"
      subtitle="Send conversion postbacks to your webhook when orders are paid."
      primaryAction={{ content: "Save", onAction: handleSave, loading: saving }}
    >
      <Layout>
        {/* Status banners */}
        {saveResult && (
          <Layout.Section>
            <Banner
              status={saveResult.type === "success" ? "success" : "critical"}
              onDismiss={() => setSaveResult(null)}
            >
              {saveResult.message}
            </Banner>
          </Layout.Section>
        )}

        {/* Webhook Configuration */}
        <Layout.AnnotatedSection
          title="Webhook Configuration"
          description="Enter your HashTopic webhook endpoint and secret. The secret is sent as the x-webhook-secret header on every postback."
        >
          <Card>
            <FormLayout>
              <TextField
                label="Webhook URL"
                value={settings.webhook_url}
                onChange={(v) => setSettings((p) => ({ ...p, webhook_url: v }))}
                placeholder="https://hooks.hashtopic.com/postback/..."
                error={errors.webhook_url}
                autoComplete="off"
                type="url"
                helpText="Must start with https://"
              />

              <TextField
                label={
                  settings.has_secret
                    ? "Webhook Secret (saved — enter new value to change)"
                    : "Webhook Secret"
                }
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
                    <Button
                      onClick={handleTest}
                      loading={testing}
                      disabled={!settings.webhook_url}
                    >
                      Send Test Postback
                    </Button>
                    {testResult && (
                      <Badge status={testResult.success ? "success" : "critical"}>
                        {testResult.message}
                      </Badge>
                    )}
                  </InlineStack>
                </BlockStack>
              </Box>
            </FormLayout>
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
                helpText="Comma-separated URL parameter names to capture. Default: click_id"
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

        {/* Paid Statuses */}
        <Layout.AnnotatedSection
          title="Conversion Triggers"
          description="Select which Shopify financial statuses should trigger a postback. 'Paid' is recommended for most stores."
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

        {/* Advanced Settings */}
        <Layout.AnnotatedSection
          title="Advanced"
          description="Debug logging redacts customer PII and never logs the webhook secret. Test mode sets 'test: true' in all payloads."
        >
          <Card>
            <FormLayout>
              <Checkbox
                label="Enable debug logging"
                helpText="Logs postback requests and responses to your server console. Customer data is redacted."
                checked={settings.debug}
                onChange={(v) => setSettings((p) => ({ ...p, debug: v }))}
              />
              <Checkbox
                label="Test mode"
                helpText='Sets "test": true in all postback payloads. Use during initial setup.'
                checked={settings.test_mode}
                onChange={(v) => setSettings((p) => ({ ...p, test_mode: v }))}
              />
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        {/* Pixel Script */}
        <Layout.AnnotatedSection
          title="Storefront Script"
          description="Add this script tag to your Shopify theme to capture click IDs from URL parameters into a first-party cookie."
        >
          <Card>
            <BlockStack gap="300">
              <Text variant="bodyMd">
                Add the following script to your theme's <code>{"<head>"}</code> or via{" "}
                <strong>Online Store → Themes → Edit Code</strong>:
              </Text>
              <Box
                background="bg-surface-secondary"
                padding="400"
                borderRadius="100"
              >
                <Text as="p" variant="bodyMd" fontFamily="mono">
                  {`<script src="https://YOUR_APP_URL/pixel/YOUR_SHOP.myshopify.com/capture.js" async></script>`}
                </Text>
              </Box>
              <Text variant="bodySm" color="subdued">
                Replace <code>YOUR_APP_URL</code> with your app's host URL and{" "}
                <code>YOUR_SHOP.myshopify.com</code> with your store's myshopify domain.
              </Text>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* Save footer */}
        <Layout.Section>
          <Box paddingBlockEnd="800">
            <ButtonGroup>
              <Button variant="primary" onClick={handleSave} loading={saving}>
                Save Settings
              </Button>
            </ButtonGroup>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
