// The tests use git repos in temporary folders, not the project users of the container. They run
// the same in the image (AGENTDECK_SANDBOX=1) as on a workstation.
process.env.AGENTDECK_SANDBOX = '0'
