import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="page page--center">
      <div className="empty">
        <h1 className="empty__title">Page not found</h1>
        <p className="empty__body">This page does not exist or you do not have access to it.</p>
        <Link href="/organisations" className="button button--secondary">
          Go to your organisations
        </Link>
      </div>
    </main>
  );
}
