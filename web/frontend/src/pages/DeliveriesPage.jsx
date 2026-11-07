import React, { useState, useEffect, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Badge,
  Button,
  Spinner,
  Text,
  BlockStack,
  EmptyState,
  Banner,
  Tooltip,
  Box,
  TextField,
  InlineStack,
} from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { useAuthenticatedFetch } from "../hooks/useAuthenticatedFetch";

function statusBadge(status) {
  switch (status) {
    case "sent":
      return <Badge status="success">Sent</Badge>;
    case "failed":
      return <Badge status="critical">Failed</Badge>;
    case "pending_retry":
      return <Badge status="warning">Pending Retry</Badge>;
    default:
      return <Badge>Pending</Badge>;
  }
}

function formatDate(isoStr) {
  if (!isoStr) return "—";
  try {
    return new Date(isoStr).toLocaleString();
  } catch {
    return isoStr;
  }
}

export default function DeliveriesPage() {
  const fetch = useAuthenticatedFetch();
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(null);
  const [banner, setBanner] = useState(null);
  const [recoveryOrderId, setRecoveryOrderId] = useState("");
  const [recovering, setRecovering] = useState(false);

  const loadDeliveries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/deliveries");
      const data = await res.json();
      setDeliveries(data.deliveries || []);
    } catch (err) {
      console.error("Failed to load deliveries:", err);
    } finally {
      setLoading(false);
    }
  }, [fetch]);

  useEffect(() => {
    loadDeliveries();
  }, [loadDeliveries]);

  const handleRetry = async (id) => {
    setRetrying(id);
    setBanner(null);
    try {
      const res = await fetch(`/api/deliveries/${id}/retry`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setBanner({ status: "success", message: `Retry triggered successfully.` });
        await loadDeliveries();
      } else {
        setBanner({ status: "critical", message: data.error || "Retry failed." });
      }
    } catch (err) {
      setBanner({ status: "critical", message: "Network error during retry." });
    } finally {
      setRetrying(null);
    }
  };

  const handleRecover = async () => {
    const id = recoveryOrderId.trim();
    if (!/^[1-9][0-9]{0,19}$/.test(id)) {
      setBanner({ status: "critical", message: "Enter the numeric Shopify order ID from the order URL, not the #1086 display number." });
      return;
    }
    setRecovering(true);
    setBanner(null);
    try {
      const response = await fetch("/api/deliveries/recover", {
        method: "POST",
        body: JSON.stringify({ order_id: id }),
      });
      const data = await response.json();
      if (!response.ok) {
        setBanner({ status: "critical", message: data.error || "Order recovery failed." });
      } else if (data.recovered) {
        setBanner({ status: "success", message: "The existing paid order was sent to MyStorefront. No additional Shopify purchase was created." });
        setRecoveryOrderId("");
      } else {
        setBanner({ status: "critical", message: `Order fetched, but delivery is ${data.delivery_status}. Check the delivery record or contact support.` });
      }
      await loadDeliveries();
    } catch {
      setBanner({ status: "critical", message: "Could not contact the staging app to recover the order." });
    } finally {
      setRecovering(false);
    }
  };

  const rows = deliveries.map((d) => [
    <Text variant="bodyMd">
      <strong>#{d.order_name || d.order_id}</strong>
    </Text>,
    formatDate(d.updated_at),
    statusBadge(d.status),
    String(d.attempts),
    d.last_http_code ? String(d.last_http_code) : "—",
    d.last_error ? (
      <Tooltip content={d.last_error}>
        <Text variant="bodySm" color="critical">
          {d.last_error.length > 40 ? d.last_error.slice(0, 40) + "…" : d.last_error}
        </Text>
      </Tooltip>
    ) : (
      "—"
    ),
    d.status !== "sent" ? (
      <Button
        size="slim"
        onClick={() => handleRetry(d.id)}
        loading={retrying === d.id}
        icon={RefreshIcon}
      >
        Retry
      </Button>
    ) : (
      "—"
    ),
  ]);

  return (
    <Page
      title="Deliveries"
      subtitle="Last 50 postback delivery attempts"
      primaryAction={{
        content: "Refresh",
        onAction: loadDeliveries,
        loading,
        icon: RefreshIcon,
      }}
      backAction={{ content: "Settings", url: "/" }}
    >
      <Layout>
        {banner && (
          <Layout.Section>
            <Banner
              status={banner.status}
              onDismiss={() => setBanner(null)}
            >
              {banner.message}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Recover an existing paid order</Text>
              <Text as="p" variant="bodySm">
                If Shopify missed a paid-order webhook, fetch that order by its numeric
                ID and send its existing MyStorefront referral. This does not create an order.
              </Text>
              <InlineStack align="start" gap="300" blockAlign="end">
                <div style={{ minWidth: "280px" }}>
                  <TextField
                    label="Shopify order ID"
                    autoComplete="off"
                    placeholder="e.g. 7274501341249"
                    value={recoveryOrderId}
                    onChange={setRecoveryOrderId}
                    helpText="Copy the number after /orders/ in Shopify Admin. Do not use #1086."
                  />
                </div>
                <Button
                  onClick={handleRecover}
                  loading={recovering}
                  disabled={!recoveryOrderId.trim()}
                >
                  Recover paid order
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {loading ? (
              <Box padding="800">
                <BlockStack inlineAlign="center" gap="400">
                  <Spinner />
                  <Text>Loading deliveries...</Text>
                </BlockStack>
              </Box>
            ) : deliveries.length === 0 ? (
              <EmptyState
                heading="No deliveries yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <Text>
                  Postback deliveries will appear here once orders are placed
                  and the postback is attempted.
                </Text>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "numeric",
                  "numeric",
                  "text",
                  "text",
                ]}
                headings={[
                  "Order",
                  "Last Attempted",
                  "Status",
                  "Attempts",
                  "HTTP Code",
                  "Last Error",
                  "Actions",
                ]}
                rows={rows}
              />
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
