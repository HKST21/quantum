import { NormalizedPhoneNumber } from '../types/aiCalls.types';

export const normalizePhoneNumber = (phone: string): NormalizedPhoneNumber => {
    const cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
    const hasCountryCode = cleaned.startsWith('+420');
    const normalized = hasCountryCode ? cleaned : `+420${cleaned}`;
    const e164Regex = /^\+420\d{9}$/;
    const isValid = e164Regex.test(normalized);

    return { original: phone, normalized, isValid, country: 'CZ' };
};

export const isCallablePhoneNumber = (phone: string): boolean => {
    const { isValid } = normalizePhoneNumber(phone);
    return isValid;
};

export const formatPhoneNumber = (phone: string): string => {
    const { normalized } = normalizePhoneNumber(phone);
    if (normalized.length === 13) {
        return `${normalized.slice(0, 4)} ${normalized.slice(4, 7)} ${normalized.slice(7, 10)} ${normalized.slice(10)}`;
    }
    return normalized;
};