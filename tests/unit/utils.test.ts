/**
 * Utility Functions Tests for cv-admin-worker
 * Tests utility functions used across the worker
 */

import { describe, it, expect } from 'vitest';
import {
    generateStableId,
    sanitizeString,
    corsHeaders,
    validateEntityId,
} from '../../src/utils';

describe('Utility Functions', () => {
    describe('generateStableId', () => {
        it('should convert to lowercase', () => {
            expect(generateStableId('TypeScript')).toBe('typescript');
            expect(generateStableId('JAVASCRIPT')).toBe('javascript');
        });

        it('should remove hash symbols (C#)', () => {
            expect(generateStableId('C#')).toBe('c');
        });

        it('should remove dots (.NET)', () => {
            expect(generateStableId('.NET')).toBe('net');
            expect(generateStableId('ASP.NET')).toBe('aspnet');
            expect(generateStableId('Node.js')).toBe('nodejs');
        });

        it('should replace non-alphanumeric with dashes', () => {
            expect(generateStableId('Visual Studio Code')).toBe('visual-studio-code');
            expect(generateStableId('React/Redux')).toBe('react-redux');
        });

        it('should trim leading and trailing dashes', () => {
            expect(generateStableId('-TypeScript-')).toBe('typescript');
            expect(generateStableId('  Angular  ')).toBe('angular');
        });

        it('should handle complex names', () => {
            expect(generateStableId('C# .NET Core')).toBe('c-net-core');
            expect(generateStableId('SQL Server 2019')).toBe('sql-server-2019');
            // Note: dots are removed before replacing non-alphanumeric, so "3.0" becomes "30"
            expect(generateStableId('Vue.js 3.0')).toBe('vuejs-30');
        });

        it('should handle empty strings', () => {
            expect(generateStableId('')).toBe('');
        });

        it('should handle numbers', () => {
            expect(generateStableId('Python3')).toBe('python3');
            expect(generateStableId('ES2022')).toBe('es2022');
        });
    });

    describe('sanitizeString', () => {
        it('should escape HTML angle brackets', () => {
            expect(sanitizeString('<script>alert("xss")</script>')).toBe(
                '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
            );
        });

        it('should escape double quotes', () => {
            expect(sanitizeString('He said "hello"')).toBe('He said &quot;hello&quot;');
        });

        it('should escape single quotes', () => {
            expect(sanitizeString("It's working")).toBe('It&#x27;s working');
        });

        it('should trim whitespace', () => {
            expect(sanitizeString('  TypeScript  ')).toBe('TypeScript');
        });

        it('should handle normal text without changes', () => {
            expect(sanitizeString('TypeScript')).toBe('TypeScript');
            expect(sanitizeString('Hello World 123')).toBe('Hello World 123');
        });

        it('should handle XSS attempts', () => {
            expect(sanitizeString('<img src=x onerror=alert(1)>')).toBe(
                '&lt;img src=x onerror=alert(1)&gt;'
            );
            expect(sanitizeString('"><script>alert(1)</script>')).toBe(
                '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'
            );
        });

        it('should handle empty strings', () => {
            expect(sanitizeString('')).toBe('');
        });
    });

    describe('corsHeaders', () => {
        it('should return default CORS headers', () => {
            const headers = corsHeaders();

            expect(headers['Access-Control-Allow-Origin']).toBe('https://admin.{YOUR_DOMAIN}');
            expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, DELETE, OPTIONS');
            expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type');
            expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
            expect(headers['Access-Control-Allow-Headers']).toContain('CF-Access-JWT-Assertion');
            expect(headers['Access-Control-Max-Age']).toBe('86400');
        });

        it('should accept custom origin', () => {
            const headers = corsHeaders('https://custom.example.com');

            expect(headers['Access-Control-Allow-Origin']).toBe('https://custom.example.com');
        });

        it('should return all required CORS headers', () => {
            const headers = corsHeaders();
            const keys = Object.keys(headers);

            expect(keys).toContain('Access-Control-Allow-Origin');
            expect(keys).toContain('Access-Control-Allow-Methods');
            expect(keys).toContain('Access-Control-Allow-Headers');
            expect(keys).toContain('Access-Control-Max-Age');
        });
    });

    describe('validateEntityId', () => {
        describe('INSERT operation', () => {
            it('should always return true for INSERT', () => {
                expect(validateEntityId('INSERT', null)).toBe(true);
                expect(validateEntityId('INSERT', undefined)).toBe(true);
                expect(validateEntityId('INSERT', 1)).toBe(true);
            });
        });

        describe('UPDATE operation', () => {
            it('should return true when entity_id is provided', () => {
                expect(validateEntityId('UPDATE', 1)).toBe(true);
                expect(validateEntityId('UPDATE', 100)).toBe(true);
            });

            it('should return true when entity_name is provided', () => {
                expect(validateEntityId('UPDATE', null, 'TypeScript')).toBe(true);
                expect(validateEntityId('UPDATE', undefined, 'React')).toBe(true);
            });

            it('should return false when neither is provided', () => {
                expect(validateEntityId('UPDATE', null)).toBe(false);
                expect(validateEntityId('UPDATE', undefined)).toBe(false);
                expect(validateEntityId('UPDATE', null, '')).toBe(false);
                expect(validateEntityId('UPDATE', null, null)).toBe(false);
            });

            it('should return true when both are provided', () => {
                expect(validateEntityId('UPDATE', 1, 'TypeScript')).toBe(true);
            });
        });

        describe('DELETE operation', () => {
            it('should return true when entity_id is provided', () => {
                expect(validateEntityId('DELETE', 1)).toBe(true);
            });

            it('should return true when entity_name is provided', () => {
                expect(validateEntityId('DELETE', null, 'TypeScript')).toBe(true);
            });

            it('should return false when neither is provided', () => {
                expect(validateEntityId('DELETE', null)).toBe(false);
                expect(validateEntityId('DELETE', undefined, '')).toBe(false);
            });
        });
    });
});
