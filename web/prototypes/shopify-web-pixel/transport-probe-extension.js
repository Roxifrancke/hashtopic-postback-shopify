/**
 * TEMPORARY, NON-ATTRIBUTING SHOPIFY WEB PIXEL TRANSPORT TEST.
 *
 * Research file. NOT deployed, NOT an automatically generated extension.
 * Replace test-store Web Pixel code ONLY in the staging app after the probe
 * has been explicitly enabled on the staging Render service.
 *
 * It sends a single EMPTY POST, without click IDs, client IDs, page URLs,
 * customer details, order data, cookies, headers with secrets, or body.
 * The probe has its own explicit staging-only flag and never credits sales.
 */
import { register } from "@shopify/web-pixels-extension";

const URL="https://hashtopic-postback-shopify-staging.onrender.com/api/staging/web-pixel-transport-probe";

register(({ analytics })=>{
  let sent=false;
  analytics.subscribe("page_viewed", async ()=>{
    if(sent)return;
    sent=true;
    try{
      const response=await fetch(URL,{
        method:"POST",
        mode:"cors",
        cache:"no-store",
      });
      console.log("[MyStorefront Staging Transport]",{
        reachable:response.status===204,
        status:response.status,
      });
    }catch{
      console.log("[MyStorefront Staging Transport]",{
        reachable:false,
        status:"fetch_failed",
      });
    }
  });
});
