import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// Email addresses to subscribe to the SNS topic
const emailAddresses = [
    
]

// Define quota code for Bedrock with labels and metrics to track
type QuotaInfo = {
    modelId: string;
    metrics: string[];
};

const quotaCodes: Record<string, QuotaInfo> = {
    "L-FF8B4E28": { modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0", metrics: ["InputTokenCount", "OutputTokenCount"] }, // tokens pm
    "L-1D3E59A3": { modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0", metrics: ["Invocations"] }, // rpm
    "L-6E888CC2": { modelId: "us.anthropic.claude-3-7-sonnet-20250219-v1:0", metrics: ["InputTokenCount", "OutputTokenCount"] }, //tokens pm
    "L-3D8CC480": { modelId: "us.anthropic.claude-3-7-sonnet-20250219-v1:0", metrics: ["Invocations"] }, // rpm
    "L-DCADBC78": { modelId: "us.anthropic.claude-3-haiku-20240307-v1:0", metrics: ["InputTokenCount", "OutputTokenCount"] }, // tokens pm
    "L-616A3F5B": { modelId: "us.anthropic.claude-3-haiku-20240307-v1:0", metrics: ["Invocations"] } // rpm
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
            const quotaInfo = quotaCodes[quota.quotaCode];
            const modelLabel = quotaInfo.modelId;
            return {
                type: "metric",
                x: (i % 2) * 12,
                y: Math.floor(i / 2) * 6,
                width: 12,
                height: 6,
                properties: {
                    metrics: [
                        ...quotaInfo.metrics.map((metric, idx) =>
                            ["AWS/Bedrock", metric, "ModelId", modelLabel, { id: `m${idx}` }]
                        ),
                        // Add a math expression if there are multiple metrics to sum them together
                        ...(quotaInfo.metrics.length > 1 ? [[
                            {
                                expression: quotaInfo.metrics.map((_, idx) => `m${idx}`).join('+'),
                                label: 'Total',
                                color: '#1f77b4'
                            }
                        ]] : [])
                    ],
                    period: 60,
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

// Create CloudWatch alarms - one per quota
function createQuotaAlarm(quota: aws.servicequotas.GetServiceQuotaResult): aws.cloudwatch.MetricAlarm {
    const quotaInfo = quotaCodes[quota.quotaCode];
    const modelLabel = quotaInfo.modelId;

    let metricAlarm = {
        alarmDescription: `Alarm when Bedrock metrics exceed 90% of quota ${quota.quotaName} (${modelLabel})`,
        comparisonOperator: "GreaterThanThreshold",
        evaluationPeriods: 1,
        threshold: quota.value * 0.9,
        alarmActions: [alarmTopic.arn],
        treatMissingData: "notBreaching"
    }

    if (quotaInfo.metrics.length > 1) {
        const metricExpressions = quotaInfo.metrics.map(metric =>
            `METRICS("AWS/Bedrock", "${metric}", "ModelId", "${modelLabel}")`
        );
        
        metricAlarm = {
            ...metricAlarm,
            ...{ 
                metricQueries: [
                    {
                        id: "e1",
                        expression: quotaInfo.metrics.map((_, idx) => `m${idx}`).join("+"),
                        label: "Combined Metrics",
                        returnData: true
                    },
                    ...quotaInfo.metrics.map((metric, idx) => ({
                        id: `m${idx}`,
                        metric: {
                            namespace: "AWS/Bedrock",
                            metricName: metric,
                            dimensions: { ModelId: modelLabel },
                            period: 60,
                            stat: "Sum"
                        },
                        returnData: false
                    }))
                ],
            }
        }
    } else {
        metricAlarm = {
            ...metricAlarm,
            ...{
                namespace: "AWS/Bedrock",
                period: 60,
                statistic: "Sum",
                dimensions: { ModelId: modelLabel },
                
            }
        }
    }
    
    return new aws.cloudwatch.MetricAlarm(`bedrock-quota-alarm-${quota.quotaCode}`,metricAlarm)
}

const alarms = pulumi.all(quotas).apply(quotaResults => {
    return quotaResults.map(createQuotaAlarm);
});

// Export the dashboard URL
export const dashboardUrl = pulumi.interpolate`https://${aws.config.region}.console.aws.amazon.com/cloudwatch/home?region=${aws.config.region}#dashboards:name=${dashboard.dashboardName}`;

export const quotaValues = quotas.map(async quota => ({
    quotaCode: (await quota).quotaCode,
    quotaName: (await quota).quotaName,
    value: (await quota).value,
    modelInfo: quotaCodes[(await quota).quotaCode]
}));

// Export alarm ARNs
export const alarmArns = alarms.apply(alarmArray =>
    alarmArray.map(alarm => alarm.arn)
);