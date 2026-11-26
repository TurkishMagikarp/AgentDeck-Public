// The tests use git repos in temporary folders, not the project users of the container. They run
// the same in the image (AGENTDECK_SANDBOX=1) as on a workstation.
process.env.AGENTDECK_SANDBOX = '0'
// The tests check the German source texts; test/i18nServer.test.ts covers the English ones.
process.env.AGENTDECK_LANG ??= 'de'
