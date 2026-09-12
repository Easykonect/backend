/**
 * Community Terms Service
 *
 * Records which version of the community terms each user accepted. With
 * REQUIRE_TERMS_ACCEPTANCE on, posting messages, reviews and listings needs
 * the current version.
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { config } from '@/config';

const currentVersion = () => config.moderation?.termsVersion ?? '';

const formatStatus = (user: { acceptedTermsVersion: string | null; acceptedTermsAt: Date | null }) => ({
  currentVersion: currentVersion(),
  acceptedVersion: user.acceptedTermsVersion,
  acceptedAt: user.acceptedTermsAt?.toISOString() ?? null,
  mustAccept: user.acceptedTermsVersion !== currentVersion(),
});

/**
 * Which terms a user has accepted, and whether they need to accept newer ones
 */
export const getTermsStatus = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { acceptedTermsVersion: true, acceptedTermsAt: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  return formatStatus(user);
};

/**
 * Accept the current community terms
 */
export const acceptTerms = async (userId: string, version: string) => {
  if (version !== currentVersion()) {
    throw new GraphQLError(`Please review and accept the current terms (version ${currentVersion()})`, {
      extensions: { code: 'TERMS_VERSION_OUTDATED' },
    });
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { acceptedTermsVersion: version, acceptedTermsAt: new Date() },
    select: { acceptedTermsVersion: true, acceptedTermsAt: true },
  });

  return formatStatus(user);
};

/**
 * When acceptance is required, stop someone posting until they've accepted
 * the current terms
 */
export const assertTermsAccepted = async (userId: string): Promise<void> => {
  if (!config.moderation?.requireTermsAcceptance) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { acceptedTermsVersion: true },
  });

  if (user?.acceptedTermsVersion !== currentVersion()) {
    throw new GraphQLError('Please accept the community terms before posting', {
      extensions: { code: 'TERMS_NOT_ACCEPTED' },
    });
  }
};
