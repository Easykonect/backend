'use client';

/**
 * Global Error Boundary
 * Handles errors that occur in the root layout
 * Must be a Client Component
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <div style={{ 
          padding: '40px', 
          textAlign: 'center', 
          fontFamily: 'system-ui, sans-serif' 
        }}>
          <h1>Something went wrong</h1>
          <p style={{ color: '#666', marginBottom: '20px' }}>
            {error.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => reset()}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              cursor: 'pointer',
              backgroundColor: '#0070f3',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
