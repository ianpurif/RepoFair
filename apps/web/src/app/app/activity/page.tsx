import { PageHeader } from '../../../components/app-shell';
import { ActivityHistory } from '../../../components/activity-history';
export default function ActivityPage() { return <main id="main" className="content-page"><PageHeader title="Purchases" subtitle="Recorded payment, delivery, and evidence states for your account." /><ActivityHistory /></main>; }
