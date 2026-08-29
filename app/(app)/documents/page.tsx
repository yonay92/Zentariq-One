import { PageHeader } from '@/components/ui/PageHeader';
import { DocumentCenterView } from '@/components/documents/DocumentCenterView';

export default function DocumentsPage() {
  return (
    <div>
      <PageHeader title="Documents" description="Every file across your company, in one place" />
      <DocumentCenterView />
    </div>
  );
}
