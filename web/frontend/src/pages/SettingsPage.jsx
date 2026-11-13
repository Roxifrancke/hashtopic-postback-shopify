import React, { useState, useEffect, useCallback } from "react";
import {
  Page, Layout, Card, FormLayout, TextField,
  Button, ButtonGroup, Banner, Spinner, Text, BlockStack,
  InlineStack, Badge, Divider, Box, List,
} from "@shopify/polaris";
import { useAuthenticatedFetch } from "../hooks/useAuthenticatedFetch";

// Settings that no longer have a field on this page (paid statuses,
// attribution, debug, test mode) are still loaded and sent back on save,
// so saved values and backend defaults keep working.
const DEFAULT_SETTINGS = {
  webhook_url: "",
  webhook_secret: "",
  has_secret: false,
  paid_statuses: ["paid"],
  param_names: "click_id",
  cookie_name: "click_id",
  cookie_days: "30",
  debug: false,
  test_mode: false,
  has_mystorefront_api_key: false,
  mystorefront_api_key: "",
  has_shopify_admin_token: false,
  mystorefront_linked_at: null,
  mystorefront_link_error: "",
  last_postback_at: null,
};

const LINK_ERRORS = {
  unknown_secret:
    "MyStorefront couldn't find your brand. Check this webhook secret matches the one in your MyStorefront Settings, then click Save.",
  brand_connected_to_other_shop:
    "Your MyStorefront brand is already connected to a different Shopify store. Contact MyStorefront support to move it.",
  shop_connected_to_other_brand:
    "This store is already connected to a different MyStorefront brand. Contact MyStorefront support.",
};

function getTrackingStatus(s) {
  if (s.mystorefront_link_error) {
    return {
      badge: "critical",
      label: "Not connected",
      message:
        LINK_ERRORS[s.mystorefront_link_error] ||
        "We couldn't connect to MyStorefront just now. Click Save to try again.",
    };
  }
  if (s.mystorefront_linked_at) {
    return { badge: "success", label: "Connected", message: "" };
  }
  if (!s.has_secret) {
    return {
      badge: "warning",
      label: "Not connected",
      message: "Follow the steps above to connect.",
    };
  }
  return {
    badge: "info",
    label: "Connecting",
    message: "Connecting to MyStorefront. Reopen this page in a moment.",
  };
}

function timeAgo(iso) {
  if (!iso) return "Never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "Never";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default function SettingsPage() {
  const fetch = useAuthenticatedFetch();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [errors, setErrors] = useState({});

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

  const status = getTrackingStatus(settings);

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
            <Banner tone={saveResult.type === "success" ? "success" : "critical"} onDismiss={() => setSaveResult(null)}>
              {saveResult.message}
            </Banner>
          </Layout.Section>
        )}

        <Layout.AnnotatedSection
          title="Webhook Configuration"
          description="Connects this app on your Shopify store to MyStorefront, so sales from creator links are tracked."
        >
          <Card>
            <BlockStack gap="500">
              <BlockStack gap="200">
                <Text variant="bodyMd" fontWeight="semibold">Setup steps</Text>
                <List type="number">
                  <List.Item>Log in to MyStorefront and open Settings.</List.Item>
                  <List.Item>Under Tracking &amp; Integration, choose Shopify.</List.Item>
                  <List.Item>Copy the Webhook URL and paste it below.</List.Item>
                  <List.Item>Copy the Webhook Secret and paste it below.</List.Item>
                  <List.Item>Click Save. Tracking Status changes to Connected.</List.Item>
                </List>
              </BlockStack>

              <Divider />

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
                  label="Webhook Secret"
                  value={settings.webhook_secret}
                  onChange={(v) => setSettings((p) => ({ ...p, webhook_secret: v }))}
                  type="password"
                  placeholder={settings.has_secret ? "••••••••••••••••••••" : "Enter your webhook secret"}
                  error={errors.webhook_secret}
                  autoComplete="new-password"
                />
              </FormLayout>

              <Divider />

              <BlockStack gap="200">
                <Text variant="bodyMd" fontWeight="semibold">Tracking Status</Text>
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone={status.badge}>{status.label}</Badge>
                  {status.message && <Text variant="bodySm" tone="subdued">{status.message}</Text>}
                </InlineStack>
              </BlockStack>

              <BlockStack gap="200">
                <Text variant="bodyMd" fontWeight="semibold">Last postback received</Text>
                <Text variant="bodySm" tone="subdued">{timeAgo(settings.last_postback_at)}</Text>
              </BlockStack>

              <BlockStack gap="200">
                <Text variant="bodyMd" fontWeight="semibold">Test Connection</Text>
                <InlineStack gap="300" align="start" blockAlign="center">
                  <Button onClick={handleTest} loading={testing} disabled={!settings.webhook_url}>
                    Send Test Postback
                  </Button>
                  {testResult && (
                    <Badge tone={testResult.success ? "success" : "critical"}>{testResult.message}</Badge>
                  )}
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

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
