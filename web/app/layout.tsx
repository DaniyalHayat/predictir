import type {ReactNode} from 'react';
import type {Metadata} from 'next';
export const metadata:Metadata = { title: "Predictir | Market research and paper trading", description: "Predictir is an independent market research and paper-trading app. Not affiliated with, endorsed by, or operated by the exchange providing market data. Predictir accounts are for this app only.", metadataBase:new URL('https://predictir.dev'), verification:{google:['FCoPfWp2NwEtKCMJq_AW6Cx2itHdrAZcG9PkS0PdpFQ','google7653305cfae6f81b']}, icons:{icon:[{url:'/favicon.ico',sizes:'any'},{url:'/favicon.svg',type:'image/svg+xml'}]} };
metadata.robots={index:false,follow:false};
export default function RootLayout({children}:{children:ReactNode}) {
  // The unauthenticated /access route needs no dashboard or analytics CSS.
  // Keep its root layout independent of the heavier workspace segment.
  return <html lang="en"><body style={{margin:0}}>{children}</body></html>;
}
