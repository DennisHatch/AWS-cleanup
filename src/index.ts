#!/usr/bin/env node

import { program } from 'commander';
import { IAMClient, ListRolesCommand, DeleteRoleCommand, Role, GetRoleCommand } from "@aws-sdk/client-iam";
import { DeleteSecurityGroupCommand, DescribeNetworkInterfacesCommand, DescribeSecurityGroupsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { isAfter, subDays } from 'date-fns'
enum resourceTypes {
    'role' = 'role',
    'securityGroup' = 'security-group'
}
const availableResourceTypes: resourceTypes[] = [resourceTypes.role, resourceTypes.securityGroup]
const defaultIdleTimeValue: number = 30;
const defaultRegion: string = 'eu-west-1';
const defaultIncludeUndefined: boolean = false;
const defaultCommitedRun: boolean = false;
const deleteYesLabel = 'yes';
const deleteNoLabel = 'no';

program
.description('Manage your stale AWS resources.')
.requiredOption(`-rt, --resource-type <resource-type>`, `Specify what type of resources to scan. (${availableResourceTypes.join('|')})`)
.option(`-r, --region <region>`, `Region to execute the scipt in. Default: ${defaultRegion}`)
.option(`-i, --idle-time <time-in-days>`, `The time, in days, the resource should be unused before deletion. Default: ${defaultIdleTimeValue}`)
.option(`-c, --commit`,`If this flag is true, resources will actually be deleted.`)
.option(`-u, --include-undefined`,`Flag to set if you want to delete resources that have not been used yet.`)
.parse(process.argv);

const options = program.opts();

const resourceType: resourceTypes = options.resourceType;
const idleTimeInDays = options.idleTime ?? defaultIdleTimeValue;
const region = options.regon ?? defaultRegion;
const includeUndefined = options.includeUndefined ?? defaultIncludeUndefined
const commitedRun = options.commit ?? defaultCommitedRun
// Input validation
if (!availableResourceTypes.includes(resourceType)) {
    console.error(`Please select a resource type from the following list: ${availableResourceTypes.join(', ')}. Given: ${resourceType}`)
}
// Logic
const askQuestion = async (q: string): Promise<string> => {
    return await new Promise(resolve => {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
            });

        readline.question(q, (input: string) => {
            readline.close();
            resolve(input);
        })
    });
}
const checkDryRunOrThrow = () => {
    if (commitedRun === false) {
        console.log(`To continue, run with option '-c'`);
        throw 'Dry run enabled.';
    }
}
const manageRoles = async () => {
    const client = new IAMClient({ region: region });
    try {
        const dateSinceIdle = subDays(new Date(), idleTimeInDays);
        const listRolesCommand = new ListRolesCommand({});
        const rolesResponse = await client.send(listRolesCommand);
        const roles: Role[] = rolesResponse.Roles || [];
        const rolesToDelete: Role[] = [];

        for (const role of roles) {
            // ListRoles does not include the property for lastUsed so we have to make individual requests
            const getRoleCommand = new GetRoleCommand({RoleName: role.RoleName});
            // This should be refactored to leverage Promise.await();
            const roleResponse = await client.send(getRoleCommand);
            if (roleResponse.Role === undefined) {
                throw `Role ${role.RoleName} not found.`;
            }
            const roleDetails: Role = roleResponse.Role;
            if (roleDetails.RoleLastUsed === undefined || roleDetails.RoleLastUsed.LastUsedDate === undefined) {
                if (includeUndefined) {
                    rolesToDelete.push(roleDetails);
                    console.log(`- ${roleDetails.RoleName}, ${roleDetails.Arn} - undefined`);
                    console.log(`${rolesToDelete.length}/${roles.length}`)
                }
            } else if (isAfter(dateSinceIdle, roleDetails.RoleLastUsed.LastUsedDate) ) {
                rolesToDelete.push(role);
                console.log(`- ${roleDetails.RoleName}, ${roleDetails.Arn} - ${roleDetails.RoleLastUsed.LastUsedDate}`);
                console.log(`${rolesToDelete.length}/${roles.length}`)
            }
        }
        console.log(`Can delete ${rolesToDelete.length} roles. Delete?`)
        const deleteConfirmation = await askQuestion(`Delete? (${deleteYesLabel}|${deleteNoLabel}): `);
        if (deleteConfirmation === deleteYesLabel) {
            checkDryRunOrThrow()
            console.log('Deleting..')
            for (const role of rolesToDelete) {
                const deleteRoleCommand = new DeleteRoleCommand({
                    RoleName: role.RoleName
                });
                await client.send(deleteRoleCommand);
                console.log(`Deleted role ${role.RoleName}`)
            }
            console.log("Finished deleting roles.")
        } else {
            console.log('Canceled.')
        }
    } catch (error) {
        console.error('Error:', error);
    } finally {
        client.destroy();
    }
}

const manageSecurityGroups = async () => {
    const client = new EC2Client({ region: region });
    try {
        // First fetch all security groups
        const securityGroupsResponse = await client.send(new DescribeSecurityGroupsCommand({}));
        const securityGroups = securityGroupsResponse.SecurityGroups || [];

        const usedSecurityGroupIds = new Set<string>();
        // Then loop over network interfaces. If there are no network interfaces that are linked with a
        // security group, the security group is unused.
        const networkInterfacesResponse = await client.send(new DescribeNetworkInterfacesCommand({}));
        const networkInterfaces = networkInterfacesResponse.NetworkInterfaces || [];

        for (const networkInterface of networkInterfaces) {
            if (networkInterface.Groups !== undefined) {
                for (const group of networkInterface.Groups) {
                    usedSecurityGroupIds.add(group.GroupId || '');
                }
            }
        }
        const unusedSecurityGroups = securityGroups.filter(group => !usedSecurityGroupIds.has(group.GroupId || ''));

        console.log('Unused Security Groups:');
        for (const group of unusedSecurityGroups) {
            console.log(`- ${group.GroupId}: ${group.GroupName}`);
        }
        const deleteConfirmation = await askQuestion(`Delete? (${deleteYesLabel}|${deleteNoLabel}): `);
        if (deleteConfirmation === deleteYesLabel) {
            checkDryRunOrThrow()
            console.log('Deleting..')
            for (const sg of unusedSecurityGroups) {
                const deleteSGCommand = new DeleteSecurityGroupCommand({
                    GroupId: sg.GroupId
                });
                await client.send(deleteSGCommand);
                console.log(`Deleted role ${sg.GroupName}`)
            }
            console.log("Finished deleting security groups.")
        } else {
            console.log('Canceled.')
        }
    } catch (error) {
        console.error('Error:', error);
    } finally {
        client.destroy();
    }
    
}

switch (resourceType) {
    case resourceTypes.role:
        manageRoles();
        break;
    case resourceTypes.securityGroup:
        manageSecurityGroups();
        break;
}
