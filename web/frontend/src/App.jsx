import React from "react";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { Frame, Navigation } from "@shopify/polaris";
import { SettingsIcon, OrderIcon } from "@shopify/polaris-icons";
import SettingsPage from "./pages/SettingsPage";
import DeliveriesPage from "./pages/DeliveriesPage";

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const navMarkup = (
    <Navigation location={location.pathname}>
      <Navigation.Section
        items={[
          {
            label: "Settings",
            icon: SettingsIcon,
            url: "/",
            onClick: () => navigate("/"),
            selected: location.pathname === "/",
          },
          {
            label: "Deliveries",
            icon: OrderIcon,
            url: "/deliveries",
            onClick: () => navigate("/deliveries"),
            selected: location.pathname === "/deliveries",
          },
        ]}
      />
    </Navigation>
  );

  return (
    <Frame navigation={navMarkup}>
      <Routes>
        <Route path="/" element={<SettingsPage />} />
        <Route path="/deliveries" element={<DeliveriesPage />} />
      </Routes>
    </Frame>
  );
}
