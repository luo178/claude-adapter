import { buildHeaders, getSessionId } from '../src/server/headers';

describe('Header Utilities', () => {
    describe('buildHeaders', () => {
        it('should build static headers', () => {
            const headers = buildHeaders([
                { name: 'x-project', value: 'demo' },
                { name: 'x-client', value: 'cli' }
            ]);

            expect(headers).toEqual({
                'x-project': 'demo',
                'x-client': 'cli'
            });
        });

        it('should support safe built-in generators', () => {
            const headers = buildHeaders([
                { name: 'x-request-id', generator: 'uuid' },
                { name: 'x-time', generator: 'timestamp()' },
                { name: 'x-iso', generator: 'isoTimestamp' }
            ]);

            expect(headers['x-request-id']).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
            expect(headers['x-time']).toMatch(/^\d+$/);
            expect(headers['x-iso']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        it('should throw for unsupported generators', () => {
            expect(() =>
                buildHeaders([{ name: 'x-danger', generator: '() => process.exit(1)' }])
            ).toThrow(/Unsupported header generator/);
        });

        it('should apply output session header last', () => {
            const headers = buildHeaders(
                [
                    { name: 'x-opencode-project', value: 'demo' },
                    { name: 'x-session', value: 'old-value' }
                ],
                {
                    outputHeader: 'x-session',
                    sessionId: 'new-session'
                }
            );

            expect(headers['x-opencode-project']).toBe('demo');
            expect(headers['x-session']).toBe('new-session');
        });
    });

    describe('getSessionId', () => {
        it('should prefer configured input header', () => {
            const sessionId = getSessionId(
                {
                    'x-custom-session': 'custom-123',
                    'x-session-id': 'fallback-456'
                },
                { inputHeader: 'x-custom-session' }
            );

            expect(sessionId).toBe('custom-123');
        });

        it('should fall back to known session headers', () => {
            const sessionId = getSessionId({
                'x-session-id': 'fallback-456'
            });

            expect(sessionId).toBe('fallback-456');
        });
    });
});
