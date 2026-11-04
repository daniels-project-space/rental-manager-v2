import {createRoot} from 'react-dom/client';
import WebsiteVerificationPanel from '../../src/components/dashboard/WebsiteVerificationPanel';
const width = new URLSearchParams(location.search).get('width');
createRoot(document.getElementById('root')!).render(<main style={{width: width ? `${width}px` : '100%', maxWidth:600,margin:'20px auto'}}><WebsiteVerificationPanel reservationId="fixture"/></main>);
