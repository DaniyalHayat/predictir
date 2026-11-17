import type {Metadata} from 'next';
import '../access/preview.css';

export const metadata:Metadata={title:'Predictir | Privacy',robots:{index:false,follow:false}};

export default function PrivacyPage(){
  return <main className="preview-entry">
    <article className="preview-card privacy-card" aria-labelledby="privacy-heading">
      <p className="preview-eyebrow">Predictir</p>
      <h1 id="privacy-heading">Privacy</h1>
      <p>Daniyal Hayat operates Predictir, a paper-trading and market research preview.</p>

      <h2>Access requests and sign-in</h2>
      <p>The access form sends your name and email address to the operator for review. Pending requests expire after seven days. A decision removes the contact details from the request record, and expired records are scrubbed during routine processing. When Google sign-in is available, Google handles the sign-in. Predictir verifies the response and discards the Google tokens after the check.</p>

      <h2>Sessions and research</h2>
      <p>Predictir uses cookies to check access and keep your browser session. Guest paper positions are stored in the browser and expire after six hours. The saved-portfolio option stores simulated positions for the authorized account. Ask Why may send the selected public market and your question to configured research and model services.</p>

      <h2>Security and service providers</h2>
      <p>The app uses network and country information to apply regional access rules, plus keyed hashes of network or account identifiers to limit abuse. Hosting, database, notification, and security providers process request metadata to deliver and protect the service. The primary site uses Cloudflare, which may collect page performance measurements. The editions run on United States cloud infrastructure, with some edge and provider processing handled elsewhere.</p>

      <h2>Privacy requests</h2>
      <p>For access, correction, deletion, or a question about this notice, contact the operator through the private channel that provided your invitation. Keep requests involving personal information out of public issues.</p>
      <a className="preview-privacy" href="/access">Back to access</a>
    </article>
  </main>;
}
