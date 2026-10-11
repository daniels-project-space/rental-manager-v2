import {createRoot} from "react-dom/client";
import DashboardPage from "../../src/app/page";
import {EditModeProvider} from "../../src/lib/dashboard/edit-mode-context";
import {AccountProvider} from "../../src/lib/account-context";
createRoot(document.getElementById("root")!).render(<AccountProvider><EditModeProvider><DashboardPage/></EditModeProvider></AccountProvider>);
