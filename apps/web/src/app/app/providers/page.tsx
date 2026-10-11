import { PageHeader } from '../../../components/app-shell';
import { ProviderDirectory } from '../../../components/provider-directory';
export default async function ProvidersPage({searchParams}:{searchParams:Promise<{packageName?:string;version?:string}>}) {
  const {packageName,version}=await searchParams;
  return <main id="main" className="content-page"><PageHeader title="Knowledge providers" subtitle="Published services at exact package versions and commits." /><ProviderDirectory {...(packageName?{packageName}:{})} {...(version?{version}:{})}/></main>;
}
