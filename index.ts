import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// Email addresses to subscribe to the SNS topic
const emailAddresses = [
    // "x@email.comm"
]

// Define quota code for Bedrock with labels
const quotaCodes: Record<string, string> = {
    "L-FF8B4E28": "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "L-6E888CC2": "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    "L-DCADBC78": "us.anthropic.claude-3-haiku-20240307-v1:0"
};

// Create an SNS topic for alarms 
const alarmTopic = new aws.sns.Topic("bedrock-quota-alarm-topic", {
    displayName: "Bedrock Quota Alarm Notifications"
});

// email addresses to the topic
const subscriptions = emailAddresses.map((email, i) => {
    return new aws.sns.TopicSubscription(`email-subscription-${i}`, {
        topic: alarmTopic.arn,
        protocol: "email",
        endpoint: email,
    });
});

const quotas = Object.keys(quotaCodes).map(code => {
    return aws.servicequotas.getServiceQuota({
        quotaCode: code,
        serviceCode: "bedrock", 
    });
});

// Create a CloudWatch dashboard for Bedrock metrics
const dashboard = new aws.cloudwatch.Dashboard("bedrock-metrics-dashboard", {
    dashboardName: "BedrockQuotaDash",
    dashboardBody: pulumi.all(quotas).apply(quotaResults => {
        const widgets = quotaResults.map((quota, i) => {
            const modelLabel = quotaCodes[quota.quotaCode];
            return {
                type: "metric",
                x: 0,
                y: i * 6,
                width: 24,
                height: 6,
                properties: {
                    metrics: [
                        ["AWS/Bedrock", "InputTokenCount", "ModelId", modelLabel],
                        ["AWS/Bedrock", "OutputTokenCount", "ModelId", modelLabel]
                    ],
                    period: 300,
                    stat: "Sum",
                    region: aws.config.region,
                    title: `${quota.quotaName} (${quota.quotaCode}) - ${modelLabel}`,
                    annotations: {
                        horizontal: [{
                            label: `Quota: ${quota.value}`,
                            value: quota.value,
                            color: "#ff9900"
                        }]
                    }
                }
            };
        });

        return JSON.stringify({ widgets });
    })
});

// Create CloudWatch alarms 
const alarms = pulumi.all(quotas).apply(quotaResults => {
    return quotaResults.flatMap(quota => {
        const modelLabel = quotaCodes[quota.quotaCode];

        // 80% threshold alarm with 30-minute period
        const alarm80 = new aws.cloudwatch.MetricAlarm(`bedrock-quota-alarm-80-${quota.quotaCode}`, {
            alarmDescription: `Alarm when Bedrock token usage exceeds 80% of quota ${quota.quotaName} (${modelLabel})`,
            comparisonOperator: "GreaterThanThreshold",
            evaluationPeriods: 1,
            metricName: "InputTokenCount",
            namespace: "AWS/Bedrock",
            period: 1800, // 30 minutes
            statistic: "Sum",
            threshold: quota.value * 0.8,
            alarmActions: [
                alarmTopic.arn
            ],
            dimensions: {
                ModelId: modelLabel
            },
        });

        // 95% threshold alarm with 1-minute period
        const alarm95 = new aws.cloudwatch.MetricAlarm(`bedrock-quota-alarm-95-${quota.quotaCode}`, {
            alarmDescription: `Alarm when Bedrock token usage exceeds 95% of quota ${quota.quotaName} (${modelLabel})`,
            comparisonOperator: "GreaterThanThreshold",
            evaluationPeriods: 1,
            metricName: "InputTokenCount",
            namespace: "AWS/Bedrock",
            period: 60, // 1 minute
            statistic: "Sum",
            threshold: quota.value * 0.95,
            alarmActions: [
                alarmTopic.arn
            ],
            dimensions: {
                ModelId: modelLabel
            },
        });

        return [alarm80, alarm95];
    });
});

// Export the dashboard URL
export const dashboardUrl = pulumi.interpolate`https://${aws.config.region}.console.aws.amazon.com/cloudwatch/home?region=${aws.config.region}#dashboards:name=${dashboard.dashboardName}`;

export const quotaValues = quotas.map(async quota => ({
    quotaCode: (await quota).quotaCode,
    quotaName: (await quota).quotaName,
    value: (await quota).value,
    modelLabel: quotaCodes[(await quota).quotaCode]
}));

// Export alarm ARNs
export const alarmArns = alarms.apply(alarmArray =>
    alarmArray.map(alarm => alarm.arn)
);